const fs = require("fs/promises");
const nodeFs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const { appendActivity } = require("./activity");
const { extractChangeType, inferChangeTypeFromAgent, inferChangeTypeHeuristic } = require("./change-type");
const {
  DEFAULTS,
  formatDuration,
  materializeConfigPaths,
  mergeConfig,
  prettyPath,
  resolveFrom,
} = require("./config");
const { readText, writeText } = require("./fs");
const { detectRepeatFailure, detectThrash } = require("./guardrails");
const { formatProgress, ensureGuardrails, appendSign, formatPrompt } = require("./prompt");
const { confirm, promptLine } = require("./confirm");
const { runShellCommand } = require("./shell");
const { loadState } = require("./state");
const { endIteration, printStep, startIteration } = require("./steps");
const { getTaskLine, parseTask, toSlug } = require("./task");
const { formatLocalTimestamp, redact, truncate, normalizeTaskSeedText } = require("./text");
const { proposePhasesWithAgent, fallbackPhasesFromSeed, renderTaskMarkdown } = require("./auto-phase");
const {
  ensureGitRepo,
  ensureGitWorktree,
  getGitModifiedFiles,
  gitCommitIfNeeded,
  gitSwitchBranch,
} = require("./git");

const ARCHIVE_DIRNAME = "archive";

function parseSkipPhaseList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => toSlug(s) || s.trim())
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function normalizeChecklistItems(items) {
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const item of items) {
    if (!item) continue;
    const text = String(item.text || "").trim();
    if (!text) continue;
    normalized.push({ checked: Boolean(item.checked), text });
  }
  return normalized;
}

function collectPlanSections(parsedTask) {
  const phases = (parsedTask && parsedTask.phases) || [];
  if (phases.length) {
    return phases.map((phase) => {
      const section = parsedTask.phaseSections && parsedTask.phaseSections[phase.id];
      return {
        scope: "phase",
        id: phase.id,
        title: String(phase.title || phase.id || "").trim(),
        items: normalizeChecklistItems(section && section.checklist),
      };
    });
  }
  return [
    {
      scope: "plan",
      id: "plan",
      title: "Plan",
      items: normalizeChecklistItems(parsedTask && parsedTask.checklist),
    },
  ];
}

function formatChecklistItem(item) {
  return `[${item.checked ? "x" : " "}] ${item.text}`;
}

function formatSectionLabel(section) {
  const title = String(section.title || "").trim();
  const id = String(section.id || "").trim();
  if (title && id && title !== id) return `${title} (${id})`;
  return title || id || "phase";
}

function formatPlanOverviewLines(parsedTask) {
  const sections = collectPlanSections(parsedTask);
  if (!sections.length) return [];
  const hasPhases = sections.some((section) => section.scope === "phase");
  const lines = [hasPhases ? "plan: phases/tasks" : "plan: tasks"];
  for (const section of sections) {
    if (section.scope === "phase") {
      lines.push(`  phase: ${formatSectionLabel(section)}`);
      if (!section.items.length) {
        lines.push("    - (no tasks)");
        continue;
      }
      for (const item of section.items) {
        lines.push(`    - ${formatChecklistItem(item)}`);
      }
      continue;
    }
    if (!section.items.length) {
      lines.push("  (no tasks)");
      continue;
    }
    for (const item of section.items) {
      lines.push(`  - ${formatChecklistItem(item)}`);
    }
  }
  return lines;
}

function countCheckedByText(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (!item || !item.checked) continue;
    const text = String(item.text || "").trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return counts;
}

function diffNewlyChecked(beforeItems, afterItems) {
  const before = countCheckedByText(beforeItems);
  const after = countCheckedByText(afterItems);
  const newly = [];
  for (const [text, afterCount] of after.entries()) {
    const beforeCount = before.get(text) || 0;
    const diff = afterCount - beforeCount;
    if (diff > 0) {
      for (let i = 0; i < diff; i += 1) {
        newly.push(text);
      }
    }
  }
  return newly;
}

function findNewlyCompletedTasks(parsedBefore, parsedAfter) {
  const beforeSections = collectPlanSections(parsedBefore);
  const afterSections = collectPlanSections(parsedAfter);
  const beforeByKey = new Map();
  for (const section of beforeSections) {
    const key = section.scope === "phase" ? `phase:${section.id}` : "plan";
    beforeByKey.set(key, section.items);
  }

  const results = [];
  for (const section of afterSections) {
    const key = section.scope === "phase" ? `phase:${section.id}` : "plan";
    const beforeItems = beforeByKey.get(key) || [];
    const newly = diffNewlyChecked(beforeItems, section.items);
    if (!newly.length) continue;
    results.push({ ...section, items: newly });
  }
  return results;
}

function formatCompletedTaskLines(completedSections) {
  if (!completedSections || !completedSections.length) return [];
  const lines = ["tasks: completed"];
  for (const section of completedSections) {
    if (section.scope === "phase") {
      lines.push(`  phase: ${formatSectionLabel(section)}`);
      for (const text of section.items) {
        lines.push(`    - [x] ${text}`);
      }
      continue;
    }
    for (const text of section.items) {
      lines.push(`  - [x] ${text}`);
    }
  }
  return lines;
}

function countChecklist(items) {
  let total = 0;
  let checked = 0;
  for (const item of items || []) {
    total += 1;
    if (item.checked) checked += 1;
  }
  return { total, checked };
}

function summarizePlanProgress(parsedTask, currentPhaseId) {
  const sections = collectPlanSections(parsedTask);
  const totals = countChecklist(sections.flatMap((section) => section.items));
  let phaseSummary = null;
  if (currentPhaseId) {
    const phase = sections.find((section) => section.scope === "phase" && section.id === currentPhaseId);
    if (phase) {
      phaseSummary = { id: phase.id, ...countChecklist(phase.items) };
    }
  }
  return { ...totals, phase: phaseSummary };
}

function formatProgressLine(summary) {
  if (!summary || !summary.total) return "progress: no tasks found";
  let line = `progress: ${summary.checked}/${summary.total} tasks checked`;
  if (summary.phase && summary.phase.total) {
    line += `; phase ${summary.phase.id}: ${summary.phase.checked}/${summary.phase.total}`;
  }
  return line;
}

function printStepLines(lines, options) {
  if (!Array.isArray(lines)) return;
  for (const line of lines) {
    if (!String(line || "").trim()) continue;
    printStep(line, options);
  }
}

async function readStdinText() {
  // Prefer reading from the stdin stream to work reliably with `spawn(..., { stdio: ["pipe", ...] })`
  // (which is how our tests provide stdin). Reading fd 0 synchronously can return empty on some
  // platforms if the pipe is not ready yet.
  const stdin = process.stdin;
  if (!stdin) return "";
  if (stdin.isTTY) return "";

  let out = "";
  const drain = () => {
    try {
      let chunk = null;
      while ((chunk = stdin.read()) !== null) out += String(chunk || "");
    } catch (_) {
      // ignore
    }
  };

  try {
    stdin.setEncoding("utf8");
  } catch (_) {
    // ignore
  }

  // Attempt to drain any buffered data immediately (covers some "fast pipe" cases).
  drain();

  // If stdin already looks ended/destroyed, try fd0 as a final fallback.
  if (stdin.readableEnded || stdin.destroyed) {
    if (!String(out || "").trim()) {
      try {
        return nodeFs.readFileSync(0, "utf8");
      } catch (_) {
        // ignore
      }
    }
    return out;
  }

  // Normal case: read from stream events until end/error.
  const streamText = await new Promise((resolve) => {
    const cleanupAndResolve = () => {
      drain();
      try {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
      } catch (_) {
        // ignore
      }
      resolve(out);
    };

    const onData = (chunk) => {
      out += String(chunk || "");
    };
    const onEnd = () => cleanupAndResolve();
    const onError = () => cleanupAndResolve();

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    try {
      stdin.resume();
    } catch (_) {
      // ignore
    }

    // In case it ended between our earlier check and listener attach.
    if (stdin.readableEnded || stdin.destroyed) cleanupAndResolve();
  });

  if (!String(streamText || "").trim()) {
    try {
      return nodeFs.readFileSync(0, "utf8");
    } catch (_) {
      // ignore
    }
  }

  return streamText;
}

async function loadTaskSeed(config) {
  const promptSeedRaw = config.promptSeed == null ? "" : String(config.promptSeed).trim();

  // Seed path: `--prompt`
  if (promptSeedRaw) {
    if (promptSeedRaw === "-") {
      const raw = await readStdinText();
      const seed = normalizeTaskSeedText(raw);
      if (!seed) throw new Error("Seed prompt from --prompt '-' (stdin) is empty.");
      return { seed, source: "--prompt" };
    }

    if (promptSeedRaw.startsWith("@")) {
      const rawPath = promptSeedRaw.slice(1).trim();
      if (!rawPath) throw new Error("Missing file path after --prompt @<file>.");
      const abs = resolveFrom(config.cwd, rawPath);
      let raw = "";
      try {
        raw = await fs.readFile(abs, "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") {
          throw new Error(`Seed prompt file not found: ${prettyPath(config.cwd, abs)}`);
        }
        if (err && err.code === "EISDIR") {
          throw new Error(`Seed prompt path is a directory: ${prettyPath(config.cwd, abs)}`);
        }
        if (err && (err.code === "EACCES" || err.code === "EPERM")) {
          throw new Error(`Permission denied reading seed prompt file: ${prettyPath(config.cwd, abs)}`);
        }
        throw new Error(
          `Failed to read seed prompt file ${prettyPath(config.cwd, abs)}: ${err && err.message ? err.message : String(err)}`
        );
      }
      const seed = normalizeTaskSeedText(raw);
      if (!seed) throw new Error(`Seed prompt file is empty: ${prettyPath(config.cwd, abs)}`);
      return { seed, source: "--prompt" };
    }

    const seed = normalizeTaskSeedText(promptSeedRaw);
    if (!seed) throw new Error("Seed prompt from --prompt is empty.");
    return { seed, source: "--prompt" };
  }
  return { seed: "", source: "" };
}

function pickCurrentPhaseId(parsedTask, state, config) {
  const phases = (parsedTask && parsedTask.phases) || [];
  if (!phases.length) return "";
  const ids = phases.map((p) => p.id);
  const skip = new Set(parseSkipPhaseList(config.skipPhase));

  const preferred = toSlug(config.phase) || String(config.phase || "").trim() || String(state.currentPhase || "").trim();
  const preferredId = toSlug(preferred) || preferred;
  const start = preferredId && ids.includes(preferredId) ? preferredId : ids[0];

  // Walk forward until we find a non-skipped phase.
  let idx = Math.max(0, ids.indexOf(start));
  for (let i = 0; i < ids.length; i += 1) {
    const candidate = ids[(idx + i) % ids.length];
    if (!skip.has(candidate)) return candidate;
  }
  return start;
}

function phaseStopOn(parsedTask, phaseId) {
  if (!phaseId) return [];
  const phase = (parsedTask.phases || []).find((p) => p.id === phaseId);
  const raw = phase && Array.isArray(phase.stopOn) ? phase.stopOn : phase && phase.stopOn ? [phase.stopOn] : [];
  return raw.map((s) => String(s || "").trim()).filter(Boolean);
}

function phaseTestCommand(parsedTask, phaseId) {
  if (!phaseId) return "";
  const fm = parsedTask.frontMatter || {};
  const phaseDefaults = parsedTask.phaseDefaults || {};
  const phase = (parsedTask.phases || []).find((p) => p.id === phaseId);
  const fromPhase = phase && phase.testCommand ? String(phase.testCommand).trim() : "";
  const fromDefaults = String(phaseDefaults.test_command || phaseDefaults.testCommand || "").trim();
  const fromGlobal = String(fm.test_command || fm.testCommand || "").trim();
  return fromPhase || fromDefaults || fromGlobal || "";
}

function isPhaseAllChecked(parsedTask, phaseId) {
  if (!phaseId) return false;
  const sec = parsedTask.phaseSections && parsedTask.phaseSections[phaseId];
  return Boolean(sec && sec.allChecked);
}

function didTestsPass(state) {
  const last = String((state && state.lastTest) || "");
  return /^pass\b/i.test(last.trim());
}

function computeNextPhaseId(parsedTask, currentPhaseId, config) {
  const phases = parsedTask.phases || [];
  if (!phases.length) return "";
  const ids = phases.map((p) => p.id);
  const skip = new Set(parseSkipPhaseList(config.skipPhase));
  const idx = ids.indexOf(currentPhaseId);
  if (idx < 0) return ids[0];
  for (let i = idx + 1; i < ids.length; i += 1) {
    if (!skip.has(ids[i])) return ids[i];
  }
  return "";
}

function stripLoopyPrefix(branch) {
  const raw = String(branch || "").trim();
  if (!raw) return "";
  if (raw.startsWith("loopy/")) return raw.slice("loopy/".length);
  if (raw.startsWith("loopy-")) return raw.slice("loopy-".length);
  if (raw.startsWith("loopy_")) return raw.slice("loopy_".length);
  return raw;
}

function archiveLoopFolderName(branch) {
  const base = stripLoopyPrefix(branch) || "completed-loop";
  const sanitized = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return sanitized || "completed-loop";
}

function isPathInside(baseDir, targetPath) {
  if (!baseDir || !targetPath) return false;
  const rel = path.relative(baseDir, targetPath);
  if (!rel) return true;
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function movePath(sourcePath, destinationPath) {
  try {
    await fs.rm(destinationPath, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }

  try {
    await fs.rename(sourcePath, destinationPath);
    return true;
  } catch (err) {
    if (err && err.code === "EXDEV") {
      const stat = await fs.stat(sourcePath);
      if (stat.isDirectory()) {
        await fs.mkdir(destinationPath, { recursive: true });
        await fs.cp(sourcePath, destinationPath, { recursive: true });
        await fs.rm(sourcePath, { recursive: true, force: true });
      } else {
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.copyFile(sourcePath, destinationPath);
        await fs.unlink(sourcePath);
      }
      return true;
    }
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function archiveCompletedLoop(config) {
  const taskPath = config.taskFile;
  if (!taskPath) return { archived: false, reason: "missing-path" };

  const taskText = await readText(taskPath);
  if (!taskText) return { archived: false, reason: "missing-plan" };

  let parsed = null;
  try {
    parsed = parseTask(taskText);
  } catch (_) {
    return { archived: false, reason: "parse-failed" };
  }
  if (!parsed.allChecked) return { archived: false, reason: "incomplete" };

  const fm = parsed.frontMatter || {};
  const fmGit = fm.git && typeof fm.git === "object" ? fm.git : {};
  const branch =
    String(config.gitBranch || "").trim() ||
    String(fm.git_branch || fm.gitBranch || "").trim() ||
    String(fmGit.branch || fmGit.git_branch || fmGit.gitBranch || "").trim();

  const baseDir = config.loopyDir || path.dirname(taskPath);
  const archiveRoot = path.join(baseDir, ARCHIVE_DIRNAME);
  const archiveDir = path.join(archiveRoot, archiveLoopFolderName(branch));
  await fs.mkdir(archiveDir, { recursive: true });

  const prettyArchive = prettyPath(config.cwd, archiveDir);
  await appendActivity(config.activityLog, [`Loop archived: ${prettyArchive}`]);

  const entries = await fs.readdir(baseDir);
  for (const entry of entries) {
    if (entry === ARCHIVE_DIRNAME) continue;
    const sourcePath = path.join(baseDir, entry);
    const destinationPath = path.join(archiveDir, entry);
    await movePath(sourcePath, destinationPath);
  }

  if (!isPathInside(baseDir, taskPath)) {
    const destinationPath = path.join(archiveDir, path.basename(taskPath));
    await movePath(taskPath, destinationPath);
  }

  return { archived: true, archiveDir };
}

async function ensureTaskBeforeLoop(config, loadedSeed) {
  const cwd = config.cwd;
  const taskPath = config.taskFile;

  let existing = await readText(taskPath);
  if (!existing) {
    const loaded = loadedSeed || (await loadTaskSeed(config));
    let seed = loaded.seed;
    if (!seed) {
      seed = await promptLine(`Enter a short plan description for ${prettyPath(cwd, taskPath)}: `);
    }
    if (!seed) {
      throw new Error(
        `Missing ${prettyPath(cwd, taskPath)} and no seed prompt provided (use --prompt, or run in a TTY).`
      );
    }

    // If auto-phase is on, try to generate phases; otherwise create a minimal legacy task file.
    let nextText = "";
    if (config.autoPhase) {
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed);
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : fallbackPhasesFromSeed(seed, { testCommand: config.testCommand });
      const fm = {
        agent_command: config.agentCommand || "",
        test_command: config.testCommand || "",
        max_iterations: config.maxIterations,
        max_minutes: config.maxMinutes,
        backoff_ms: config.backoffMs,
        rotate_bytes: config.rotateBytes,
        git: {
          branch: config.gitBranch || "",
          commit: Boolean(config.gitCommit),
          commit_message: config.gitCommitMessage || "",
        },
      };
      nextText = renderTaskMarkdown({
        frontMatter: fm,
        phaseDefaults: plan.phaseDefaults,
        phases: plan.phases,
        tasksByPhase: plan.tasksByPhase,
        includeSeedComment: true,
        seedText: seed,
      });
    } else {
      nextText = [
        "---",
        yaml.dump(
          {
            agent_command: config.agentCommand || "",
            test_command: config.testCommand || "",
            max_iterations: config.maxIterations,
            max_minutes: config.maxMinutes,
            backoff_ms: config.backoffMs,
            rotate_bytes: config.rotateBytes,
          },
          { lineWidth: 120 }
        ).trimEnd(),
        "---",
        "",
        "# Plan",
        "",
        `- [ ] ${seed}`,
        "",
      ].join("\n");
    }

    const ok = await confirm(`Write new ${prettyPath(cwd, taskPath)}?`, {
      confirm: config.confirm,
      defaultYes: true,
    });
    if (!ok) throw new Error(`Aborted: ${prettyPath(cwd, taskPath)} not created.`);
    await writeText(taskPath, nextText);
    return { taskText: nextText, rewritten: true };
  }

  // User-provided prompt explicitly requests an update (apply automatically).
  const loaded = loadedSeed || (await loadTaskSeed(config));
  if (loaded.seed) {
    const seed = loaded.seed;
    const parsed = parseTask(existing);
    const fm = parsed.frontMatter || {};

    let nextText = existing;
    if (config.autoPhase) {
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed);
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : fallbackPhasesFromSeed(seed, { testCommand: fm.test_command || fm.testCommand || config.testCommand });
      nextText = renderTaskMarkdown({
        frontMatter: fm,
        phaseDefaults: plan.phaseDefaults,
        phases: plan.phases,
        tasksByPhase: plan.tasksByPhase,
        includeSeedComment: true,
        seedText: seed,
      });
    } else {
      // Non-phased update: overwrite checklist with a single new item.
      nextText = [
        "---",
        yaml.dump(fm, { lineWidth: 120 }).trimEnd(),
        "---",
        "",
        "# Plan",
        "",
        `- [ ] ${seed}`,
        "",
      ].join("\n");
    }

    if (nextText !== existing) {
      const ok = await confirm(`Update ${prettyPath(cwd, taskPath)}?`, {
        confirm: config.confirm,
        defaultYes: true,
      });
      if (!ok) throw new Error(`Aborted: ${prettyPath(cwd, taskPath)} not updated.`);
      await writeText(taskPath, nextText);
      return { taskText: nextText, rewritten: true };
    }
    return { taskText: existing, rewritten: false };
  }

  // Auto-phase insertion (only when enabled and phases are absent).
  if (config.autoPhase) {
    const parsed = parseTask(existing);
    const hasPhases = Boolean(parsed.phases && parsed.phases.length);
    if (!hasPhases) {
      const seed = parsed.body && parsed.body.trim() ? parsed.body.trim() : existing.trim();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed);
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : null;
      if (plan) {
        const nextText = renderTaskMarkdown({
          frontMatter: parsed.frontMatter || {},
          phaseDefaults: plan.phaseDefaults,
          phases: plan.phases,
          tasksByPhase: plan.tasksByPhase,
          includeSeedComment: true,
          seedText: seed,
        });
        if (nextText !== existing) {
          const ok = await confirm(`Apply auto-phase plan to ${prettyPath(cwd, taskPath)}?`, {
            confirm: config.confirm,
            defaultYes: false,
          });
          if (ok) {
            await writeText(taskPath, nextText);
            return { taskText: nextText, rewritten: true };
          }
        }
      }
    }
  }

  return { taskText: existing, rewritten: false };
}

async function runIteration(config) {
  let bytesRead = 0;
  let bytesWritten = 0;
  const guardrailStopReasons = [];

  const taskText = await readText(config.taskFile);
  bytesRead += Buffer.byteLength(taskText);
  if (!taskText) {
    throw new Error(`Missing ${config.taskFile}.`);
  }

  const parsedTask = parseTask(taskText);

  if (parsedTask.allChecked) {
    await appendActivity(config.activityLog, ["Plan complete. Stopping loop."]);
    printStep("plan: complete; stopping loop");
    return { status: "complete", bytes: 0 };
  }

  let guardrailsText = await readText(config.guardrailsFile);
  bytesRead += Buffer.byteLength(guardrailsText);

  const ensuredGuardrails = ensureGuardrails(guardrailsText);
  if (ensuredGuardrails !== guardrailsText) {
    await writeText(config.guardrailsFile, ensuredGuardrails);
    bytesWritten += Buffer.byteLength(ensuredGuardrails);
    guardrailsText = ensuredGuardrails;
  }

  const progressText = await readText(config.progressFile);
  bytesRead += Buffer.byteLength(progressText);

  const loaded = await loadState(config.stateFile);
  const state = loaded.state;
  bytesRead += loaded.bytes;

  const iteration = (state.iteration || 0) + 1;
  const rotationPending = Boolean(state.rotatePending);

  const currentPhaseId = pickCurrentPhaseId(parsedTask, state || {}, config);
  const phaseLabel = currentPhaseId ? `, phase: ${currentPhaseId}` : "";
  const iterationStartedAt = new Date();
  startIteration({ iteration, phase: currentPhaseId, startedAt: iterationStartedAt });
  try {
    printStep(`start (rotation: ${rotationPending ? "fresh" : "standard"}${phaseLabel})`, { iteration });

    const lastOutputRaw = rotationPending ? "" : await readText(path.join(config.loopyDir, "last_agent_output.txt"));
    bytesRead += Buffer.byteLength(lastOutputRaw);
    const lastOutput = truncate(lastOutputRaw, 4000);

    const hintsTextRaw = await readText(config.hintsFile);
    bytesRead += Buffer.byteLength(hintsTextRaw);
    const hintsText = truncate(hintsTextRaw, 8000);

    const prompt = formatPrompt({
      iteration,
      taskText,
      taskSeedText: config.taskSeedText || "",
      taskSeedSource: config.taskSeedSource || "",
      guardrailsText,
      progressText: progressText || "(no progress recorded yet)",
      lastOutput,
      rotationPending,
      currentPhase: currentPhaseId,
      taskFilePath: config.taskFile,
      hintsText,
    });

    await writeText(config.promptFile, prompt);
    bytesWritten += Buffer.byteLength(prompt);
    printStep(`prompt: saved to ${prettyPath(config.cwd, config.promptFile)}`, { iteration });

    await appendActivity(config.activityLog, [
      `Iteration ${iteration} start`,
      `Rotation pending: ${rotationPending ? "yes" : "no"}`,
    ]);

    if (config.dryRun) {
      await appendActivity(config.activityLog, ["Dry run enabled. Skipping agent execution."]);
      printStep("dry run: enabled; skipping agent execution", { iteration });
      return { status: "dry-run", bytes: bytesRead + bytesWritten };
    }

    if (!config.agentCommand) {
      throw new Error(
        `Missing agent_command. Set it in ${prettyPath(config.cwd, config.taskFile)} front matter or use --agent.`
      );
    }

    if (config.preIteration) {
      printStep(`hook preIteration: run ${redact(config.preIteration)}`, { iteration });
      const hookResult = await runShellCommand(config.preIteration, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
      });
      await appendActivity(config.activityLog, [`preIteration hook exit ${hookResult.code}`]);
      printStep(`hook preIteration: exit ${hookResult.code}`, { iteration });
    }

    const agentStreamLogPath = config.agentStreamLog
      ? resolveFrom(config.cwd, config.agentStreamLog)
      : path.join(config.loopyDir, "agent_stream.log");
    const lastAgentOutputPath = path.join(config.loopyDir, "last_agent_output.txt");
    const lastTestOutputPath = path.join(config.loopyDir, "last_test_output.txt");

    // Write a small header so runs are easy to separate.
    await fs.mkdir(path.dirname(agentStreamLogPath), { recursive: true });
    await fs.appendFile(
      agentStreamLogPath,
      `\n\n===== Iteration ${iteration} @ ${new Date().toISOString()} =====\n$ ${redact(
        config.agentCommand
      )}\n\n`,
      "utf8"
    );

    printStep(
      `agent: run ${redact(config.agentCommand)} (stream log: ${prettyPath(config.cwd, agentStreamLogPath)})`,
      { iteration }
    );
    const agentResult = await runShellCommand(config.agentCommand, prompt, DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
      agentStreamLogPath,
      streamToTerminal: Boolean(config.stream),
    });
    const redactedStdout = redact(agentResult.stdout);
    const redactedStderr = redact(agentResult.stderr);
    const combinedOutput = truncate(`${redactedStdout}\n${redactedStderr}`, DEFAULTS.maxOutputBytes);

    await writeText(lastAgentOutputPath, combinedOutput);
    bytesWritten += Buffer.byteLength(combinedOutput);

    let status = agentResult.code === 0 ? "success" : "failure";
    let lastError = "";
    let errorSignature = "";

    if (status === "failure") {
      const firstErrorLine = (redactedStderr || redactedStdout).split(/\r?\n/).find(Boolean) || "unknown";
      lastError = firstErrorLine;
      errorSignature = `${config.agentCommand}::${firstErrorLine}`;
      printStep(
        `agent: exit ${agentResult.code}; error: ${lastError} (see ${prettyPath(
          config.cwd,
          lastAgentOutputPath
        )})`,
        { iteration, level: "error" }
      );
    } else {
      printStep(`agent: exit ${agentResult.code}`, { iteration });
    }

    let testStatus = "n/a";
    const effectiveTestCommand = currentPhaseId ? phaseTestCommand(parsedTask, currentPhaseId) : config.testCommand;
    if (status === "success" && effectiveTestCommand) {
      printStep(`tests: run ${redact(effectiveTestCommand)}`, { iteration });
      const testResult = await runShellCommand(effectiveTestCommand, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
      });
      const testOutput = truncate(redact(`${testResult.stdout}\n${testResult.stderr}`), DEFAULTS.maxOutputBytes);
      await writeText(lastTestOutputPath, testOutput);
      bytesWritten += Buffer.byteLength(testOutput);
      const testOutcome = testResult.code === 0 ? "pass" : "fail";
      const testTimestamp = formatLocalTimestamp(new Date());
      testStatus = testTimestamp ? `${testOutcome} @ ${testTimestamp}` : `${testOutcome}`;
      if (testOutcome === "fail") {
        printStep(
          `tests: result fail (see ${prettyPath(config.cwd, lastTestOutputPath)})`,
          { iteration, level: "error" }
        );
      } else {
        printStep(`tests: result pass`, { iteration });
      }
      if (testOutcome === "fail") {
        status = "failure";
        lastError = testOutput.split(/\r?\n/).find(Boolean) || "test failure";
        errorSignature = `${effectiveTestCommand}::${lastError}`;
      }
    }

    const taskAfter = await readText(config.taskFile);
    bytesRead += Buffer.byteLength(taskAfter);
    const parsedTaskAfter = taskAfter ? parseTask(taskAfter) : parsedTask;
    const taskComplete = Boolean(parsedTaskAfter.allChecked);
    const completedSections = findNewlyCompletedTasks(parsedTask, parsedTaskAfter);
    printStepLines(formatCompletedTaskLines(completedSections), { iteration });
    printStep(formatProgressLine(summarizePlanProgress(parsedTaskAfter, currentPhaseId)), { iteration });
    const taskLine = getTaskLine(taskAfter || taskText, { phaseId: currentPhaseId });
    const taskContext = extractChangeType(taskLine);
    const taskSummary = taskContext.summary;
    let changeType = taskContext.changeType;
    if (taskContext.changeType === "chore" && !/^[a-zA-Z]+\s*:/.test(taskLine || "")) {
      if (config.gitCommit) {
        const agentType = await inferChangeTypeFromAgent(config.agentCommand, taskLine);
        changeType = agentType || inferChangeTypeHeuristic(taskLine);
      } else {
        changeType = inferChangeTypeHeuristic(taskLine);
      }
    }
    await appendActivity(config.activityLog, [`change_type inferred: ${changeType} (task: ${taskLine})`]);

    let postIterationRan = false;
    if (status === "success" && config.postIteration) {
      printStep(`hook postIteration: run ${redact(config.postIteration)}`, { iteration });
      const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
      });
      postIterationRan = true;
      await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
      printStep(`hook postIteration: exit ${hookResult.code}`, { iteration });
    }

    if (status === "success") {
      try {
        if (config.gitCommit) {
          printStep("git: commit enabled; checking changes", { iteration });
        }
        const commitResult = await gitCommitIfNeeded(config, {
          iteration,
          status,
          testStatus,
          taskComplete,
          taskSummary,
          changeType,
        });
        if (commitResult.committed) {
          await appendActivity(config.activityLog, [
            `git commit: ${commitResult.hash || "(unknown hash)"} ${commitResult.message}`,
          ]);
          printStep(`git: commit created ${commitResult.hash || "(unknown hash)"}`, { iteration });
        } else if (config.gitCommit) {
          printStep(`git: commit skipped: ${commitResult.reason}`, { iteration });
        }
      } catch (err) {
        status = "failure";
        lastError = err && err.message ? err.message : String(err);
        errorSignature = `git commit::${lastError}`;
        printStep(`git: commit failed: ${lastError}`, { iteration, level: "error" });
      }
    }

    if (status === "failure" && config.onFailure) {
      printStep(`hook onFailure: run ${redact(config.onFailure)}`, { iteration });
      const hookResult = await runShellCommand(config.onFailure, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
      });
      await appendActivity(config.activityLog, [`onFailure hook exit ${hookResult.code}`]);
      printStep(`hook onFailure: exit ${hookResult.code}`, { iteration });
    }

    if (!postIterationRan && config.postIteration) {
      printStep(`hook postIteration: run ${redact(config.postIteration)}`, { iteration });
      const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
      });
      await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
      printStep(`hook postIteration: exit ${hookResult.code}`, { iteration });
    }

    const modifiedFiles = await getGitModifiedFiles(config.cwd);
    let nextState = {
      ...state,
      iteration,
      lastStatus: taskComplete ? "complete" : status,
      lastTest: testStatus,
      lastError: lastError || state.lastError || "",
      lastBytes: bytesRead + bytesWritten,
      rotatePending: false,
      updatedAt: new Date().toISOString(),
      startedAt: state.startedAt || new Date().toISOString(),
      history: state.history || [],
      currentPhase: currentPhaseId || state.currentPhase || "",
      phaseHistory: state.phaseHistory || [],
    };

    const historyEntry = `${nextState.updatedAt} iteration ${iteration} ${status} (test: ${testStatus})`;
    nextState.history = [...nextState.history, historyEntry].slice(-50);

    // Phase completion / progression.
    if (status === "success" && currentPhaseId && parsedTask.phases && parsedTask.phases.length) {
      const stopOn = phaseStopOn(parsedTask, currentPhaseId);
      const phaseChecked = isPhaseAllChecked(parseTask(taskAfter || taskText), currentPhaseId);
      const criteria = stopOn.length ? stopOn : ["all_checked"];
      const needsAllChecked = criteria.includes("all_checked");
      const needsTests = criteria.includes("tests_pass");
      const testsOk = !needsTests || (testStatus !== "n/a" ? /^pass\b/i.test(testStatus) : didTestsPass(nextState));
      const phaseOk = !needsAllChecked || phaseChecked;
      const phaseComplete = phaseOk && testsOk;

      if (phaseComplete) {
        const nextPhase = computeNextPhaseId(parsedTask, currentPhaseId, config);
        nextState.phaseHistory = [...(nextState.phaseHistory || [])].concat([
          `${nextState.updatedAt} phase ${currentPhaseId} complete`,
        ]).slice(-100);
        if (config.phaseOnly) {
          nextState.lastStatus = "phase-complete";
        } else if (nextPhase) {
          nextState.currentPhase = nextPhase;
          nextState.phaseHistory = [...(nextState.phaseHistory || [])].concat([
            `${nextState.updatedAt} phase advanced: ${currentPhaseId} -> ${nextPhase}`,
          ]).slice(-100);
        }
      }
    }

    if (status === "failure") {
      const repeat = detectRepeatFailure(nextState, errorSignature);
      nextState = repeat.state;

      const thrashCheck = detectThrash(nextState, modifiedFiles);
      nextState = thrashCheck.state;

      let guardrailsUpdated = guardrailsText;

      if (repeat.repeated) {
        guardrailsUpdated = appendSign(guardrailsUpdated, `Repeated failure signature: ${errorSignature}`);
        guardrailStopReasons.push("Repeated failure signature (>= 3).");
      }

      if (thrashCheck.thrash) {
        guardrailsUpdated = appendSign(guardrailsUpdated, `File thrashing detected: ${modifiedFiles.join(", ")}`);
        guardrailStopReasons.push("File thrashing detected (>= 3).");
      }

      if (guardrailsUpdated !== guardrailsText) {
        await writeText(config.guardrailsFile, guardrailsUpdated);
        bytesWritten += Buffer.byteLength(guardrailsUpdated);
      }
    }

    const guardrailStopReason = guardrailStopReasons.join(" ");
    if (guardrailStopReason) {
      nextState.lastStatus = "guardrail-stop";
      nextState.lastError = guardrailStopReason;
      printStep(
        `guardrail: stop (${guardrailStopReason}) (see ${prettyPath(config.cwd, config.guardrailsFile)})`,
        { iteration, level: "warn" }
      );
    }

    if (bytesRead + bytesWritten >= config.rotateBytes) {
      nextState.rotatePending = true;
    }

    const progressPayload = formatProgress(nextState);
    await writeText(config.progressFile, progressPayload);
    bytesWritten += Buffer.byteLength(progressPayload);

    const statePayload = JSON.stringify(nextState, null, 2) + "\n";
    await writeText(config.stateFile, statePayload);
    bytesWritten += Buffer.byteLength(statePayload);
    printStep(
      `state: updated ${prettyPath(config.cwd, config.stateFile)} (status: ${nextState.lastStatus}, test: ${nextState.lastTest})`,
      { iteration }
    );

    await appendActivity(config.activityLog, [
      `Iteration ${iteration} ${status}`,
      `Bytes read/written: ${bytesRead}/${bytesWritten}`,
    ]);

    if (taskComplete) {
      await appendActivity(config.activityLog, ["Plan complete detected after iteration."]);
      printStep("plan: complete after iteration", { iteration });
      return { status: "complete", bytes: bytesRead + bytesWritten };
    }

    if (nextState.lastStatus === "phase-complete") {
      await appendActivity(config.activityLog, [`Phase complete (${currentPhaseId}); --phase-only stopping.`]);
      printStep(`phase: ${currentPhaseId} complete; --phase-only stopping`, { iteration });
      return { status: "complete", bytes: bytesRead + bytesWritten };
    }

    printStep(`result: ${status} (test: ${testStatus})`, { iteration });
    return { status, bytes: bytesRead + bytesWritten, guardrailStopReason };
  } finally {
    endIteration({ iteration });
  }
}

async function runLoop(command, flags, { stopSignal, onActivityLog } = {}) {
  const stop = stopSignal || { stopRequested: false };
  const baseCwd = process.cwd();
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  if (command === "run") {
    throw new Error("Unsupported command. For a single iteration, use `loopy --max-iterations 1`.");
  }

  // No legacy flag compatibility: fail fast with a clear message.
  if (hasOwn(flags, "task")) throw new Error("Unsupported legacy flag provided. Use `--plan <file>` instead.");
  if (hasOwn(flags, "agent-cmd"))
    throw new Error("Unsupported legacy flag provided. Use `--agent <command>` instead.");
  if (hasOwn(flags, "task-prompt"))
    throw new Error("Unsupported legacy seed flag provided. Use `--prompt \"<text>\"` instead.");
  if (hasOwn(flags, "task-file") || hasOwn(flags, "task-prompt-file"))
    throw new Error("Unsupported legacy seed flag provided. Use `--prompt @<file>` (or `--prompt -`) instead.");
  if (hasOwn(flags, "prompt-file")) throw new Error("Unsupported legacy flag provided. Use `--prompt-out <file>` instead.");

  const defaultPlanPath = resolveFrom(baseCwd, flags.plan || DEFAULTS.taskFile);
  const planText = await readText(defaultPlanPath);

  const parsedTask = planText ? parseTask(planText) : { frontMatter: {} };
  let config = mergeConfig(flags, parsedTask.frontMatter);

  // `--continue` is a "resume only" mode: don't accept seed prompt updates here.
  if (config.continue && hasOwn(flags, "prompt")) {
    throw new Error("`--continue` cannot be used with `--prompt`. Omit `--prompt` to resume, or run without `--continue`.");
  }

  // Validate seed prompt flag early.
  if (hasOwn(flags, "prompt")) {
    if (flags.prompt === true) {
      throw new Error("Missing value for --prompt (expected text, @<file>, or '-').");
    }
    const v = String(flags.prompt || "").trim();
    if (!v) throw new Error("Missing value for --prompt (expected text, @<file>, or '-').");
    if (v.startsWith("@") && !v.slice(1).trim()) {
      throw new Error("Missing file path after --prompt @<file>.");
    }
  }

  // Validate prompt output flag.
  if (flags["prompt-out"] === true) {
    throw new Error("Missing value for --prompt-out (expected a file path).");
  }

  const fm0 = (parsedTask && parsedTask.frontMatter) || {};
  const fmGit = fm0.git && typeof fm0.git === "object" ? fm0.git : {};
  const gitCommitExplicit =
    hasOwn(flags, "git-commit") ||
    Object.prototype.hasOwnProperty.call(fm0, "git_commit") ||
    Object.prototype.hasOwnProperty.call(fm0, "gitCommit") ||
    Object.prototype.hasOwnProperty.call(fmGit, "commit") ||
    Object.prototype.hasOwnProperty.call(fmGit, "git_commit") ||
    Object.prototype.hasOwnProperty.call(fmGit, "gitCommit");
  let isGitRepo = false;
  try {
    await ensureGitRepo(baseCwd);
    isGitRepo = true;
  } catch (_) {
    isGitRepo = false;
  }
  if (!isGitRepo && !gitCommitExplicit) {
    config.gitCommit = false;
  }

  // Ensure agent command is defined before any planning/execution.
  if (!config.agentCommand) {
    const entered = await promptLine('Enter agent command (e.g. "cursor-agent"): ');
    if (!entered) {
      throw new Error(
        `Missing agent_command. Set it in ${prettyPath(baseCwd, resolveFrom(baseCwd, config.taskFile))} front matter or use --agent.`
      );
    }
    config.agentCommand = entered;
  }

  // Default git branch when missing (only when running inside a git repo).
  if (!config.continue) {
    const hasGitBranch = Boolean(String(config.gitBranch || "").trim());
    const hasWorktreeBranch = Boolean(String(config.gitWorktreeBranch || "").trim());
    if (!hasGitBranch && !hasWorktreeBranch) {
      if (isGitRepo) {
        if (!process.stdin.isTTY) {
          throw new Error(
            "Missing git branch name. Provide --git-branch <name> or set git.branch in the plan front matter."
          );
        }
        const entered = await promptLine('Enter git branch name (e.g. "loopy/my-task"): ');
        if (!entered) {
          throw new Error("Aborted: git branch name is required.");
        }
        config.gitBranch = String(entered || "").trim();
      }
    }
  }

  printStep(
    `loop: start (max iterations: ${config.maxIterations}, max minutes: ${config.maxMinutes}, backoff: ${config.backoffMs}ms)`
  );

  // Optional git workspace setup (worktree / branch). This is done once, before the loop.
  let effectiveCwd = baseCwd;
  if (config.gitWorktree) {
    const worktreeAbs = resolveFrom(baseCwd, config.gitWorktree);
    if (config.continue) {
      // Resume mode: use existing worktree path only (don't create/switch).
      try {
        const stat = await fs.stat(worktreeAbs);
        if (!stat.isDirectory()) {
          throw new Error(`Worktree path exists but is not a directory: ${worktreeAbs}`);
        }
      } catch (err) {
        if (err && err.code === "ENOENT") {
          throw new Error(
            `Cannot continue: git worktree path not found: ${prettyPath(baseCwd, worktreeAbs)} (run without --continue to create it)`
          );
        }
        throw err;
      }
      effectiveCwd = worktreeAbs;
      await ensureGitRepo(effectiveCwd);
      printStep(`git worktree: using existing ${prettyPath(baseCwd, effectiveCwd)} (--continue)`, {});
    } else {
      printStep(
        `git worktree: ensure ${prettyPath(baseCwd, worktreeAbs)}` +
          (config.gitWorktreeBranch ? ` (branch: ${config.gitWorktreeBranch})` : " (detached)"),
        {}
      );
      effectiveCwd = await ensureGitWorktree(baseCwd, config.gitWorktree, config.gitWorktreeBranch);
      printStep(`git worktree: using ${prettyPath(baseCwd, effectiveCwd)}`, {});
    }
  }
  // If a worktree branch was specified, don't switch away from it via any default/implicit `gitBranch`.
  // Only honor `gitBranch` when the user explicitly provided it (flag or plan front matter).
  const gitBranchExplicit = Boolean(
    String(flags["git-branch"] || "").trim() ||
      String(fm0.git_branch || fm0.gitBranch || "").trim() ||
      String(fmGit.branch || fmGit.git_branch || fmGit.gitBranch || "").trim()
  );
  if (config.gitWorktree && config.gitWorktreeBranch && !gitBranchExplicit) {
    config.gitBranch = "";
  }
  if (config.gitBranch) {
    if (config.continue) {
      printStep(`git branch: skipping switch to ${config.gitBranch} (--continue)`, {});
    } else {
      printStep(`git branch: switch to ${config.gitBranch}`, {});
      await ensureGitRepo(effectiveCwd);
      await gitSwitchBranch(effectiveCwd, config.gitBranch);
      printStep(`git branch: now on ${config.gitBranch}`, {});
    }
  }

  config = materializeConfigPaths(config, effectiveCwd);
  if (onActivityLog) onActivityLog(config.activityLog);

  if (config.continue) {
    // Resume mode: require existing plan + state, but do not create/update the plan doc.
    const taskTextNow = await readText(config.taskFile);
    if (!taskTextNow) {
      throw new Error(
        `Cannot continue: missing ${prettyPath(config.cwd, config.taskFile)}. Run \`loopy init\` or run without --continue and provide --prompt.`
      );
    }

    let stateText = "";
    try {
      stateText = await fs.readFile(config.stateFile, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new Error(
          `No Loopy state found at ${prettyPath(config.cwd, config.stateFile)}.\nRun \`loopy\` first (without --continue).`
        );
      }
      throw err;
    }

    let resumeState = null;
    try {
      resumeState = JSON.parse(stateText);
    } catch (err) {
      throw new Error(
        `Failed to parse Loopy state at ${prettyPath(config.cwd, config.stateFile)}: ${
          err && err.message ? err.message : String(err)
        }`
      );
    }

    const phase = resumeState && resumeState.currentPhase ? `, phase: ${resumeState.currentPhase}` : "";
    const iter = resumeState && resumeState.iteration != null ? resumeState.iteration : 0;
    const last = (resumeState && resumeState.lastStatus) || "n/a";
    printStep(`resume: iter ${iter}${phase}; last status: ${last}`, {});
    config.taskSeedText = "";
    config.taskSeedSource = "";
  } else {
    // Load the plan seed once so stdin ('-') works and prompts can reuse the content.
    const loadedSeed = await loadTaskSeed(config);
    config.taskSeedText = loadedSeed.seed || "";
    config.taskSeedSource = loadedSeed.source || "";

    // Plan initialization / auto-phase planning happens once, before looping.
    const ensured = await ensureTaskBeforeLoop(config, loadedSeed);
    if (ensured.rewritten) {
      await appendActivity(config.activityLog, [
        `Plan updated before loop: ${prettyPath(config.cwd, config.taskFile)}`,
      ]);
      printStep(`plan: updated before loop: ${prettyPath(config.cwd, config.taskFile)}`, {});
      const planText = ensured.taskText || (await readText(config.taskFile));
      const planLines = formatPlanOverviewLines(parseTask(planText));
      printStepLines(planLines, {});
    }
  }

  // Persist key defaults into the plan front matter when missing (agent/test/git settings).
  const applyFrontMatterPatch = async (patchFn) => {
    const text = await readText(config.taskFile);
    if (!text) return;
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    let fm = {};
    let body = text;
    if (m) {
      try {
        fm = yaml.load(m[1]) || {};
      } catch (_) {
        fm = {};
      }
      body = text.slice(m[0].length);
    }
    const nextFm = (patchFn && patchFn(fm)) || fm;
    const yamlText = yaml.dump(nextFm, { lineWidth: 120 }).trimEnd();
    const normalizedBody = String(body || "").replace(/^\n+/, "");
    const next = ["---", yamlText, "---", "", normalizedBody].join("\n");
    if (next !== text) await writeText(config.taskFile, next);
  };

  await applyFrontMatterPatch((fm) => {
    const next = { ...(fm || {}) };
    if (!String(next.agent_command || next.agentCommand || "").trim()) {
      next.agent_command = config.agentCommand || "";
    }
    // Only persist a test command if one is already configured (we don't require it).
    if (String(config.testCommand || "").trim() && !String(next.test_command || next.testCommand || "").trim()) {
      next.test_command = String(config.testCommand || "").trim();
    }
    const git = next.git && typeof next.git === "object" ? { ...next.git } : {};
    if (config.gitBranch && !String(git.branch || git.git_branch || git.gitBranch || "").trim()) {
      git.branch = config.gitBranch;
    }
    const hasCommit =
      Object.prototype.hasOwnProperty.call(git, "commit") ||
      Object.prototype.hasOwnProperty.call(git, "git_commit") ||
      Object.prototype.hasOwnProperty.call(git, "gitCommit");
    if (!hasCommit && config.gitCommit) {
      git.commit = true;
    }
    if (Object.keys(git).length) next.git = git;
    return next;
  });

  const start = Date.now();
  let iteration = 0;

  while (!stop.stopRequested) {
    const elapsedMinutes = (Date.now() - start) / 60000;
    if (iteration >= config.maxIterations) {
      await appendActivity(config.activityLog, ["Max iterations reached. Stopping."]);
      printStep("loop: max iterations reached; stopping");
      break;
    }
    if (elapsedMinutes >= config.maxMinutes) {
      await appendActivity(config.activityLog, [
        `Max wall time reached (${formatDuration(config.maxMinutes)}). Stopping.`,
      ]);
      printStep(`loop: max wall time reached (${formatDuration(config.maxMinutes)}); stopping`);
      break;
    }

    const result = await runIteration(config);
    iteration += 1;

    if (result.status === "complete") {
      break;
    }

    // `--dry-run` builds the prompt and skips agent execution. Since dry runs don't
    // advance state iterations, stop after the first iteration to avoid looping
    // forever (and to keep CLI/test behavior fast and predictable).
    if (config.dryRun) {
      await appendActivity(config.activityLog, ["Dry run complete. Stopping."]);
      printStep("dry run: complete; stopping");
      break;
    }

    if (result.guardrailStopReason) {
      await appendActivity(config.activityLog, [`Guardrail stop triggered: ${result.guardrailStopReason}`]);
      break;
    }

    if (stop.stopRequested) {
      await appendActivity(config.activityLog, ["Stop requested. Exiting loop."]);
      printStep("loop: stop requested; exiting");
      break;
    }

    if (config.backoffMs > 0) {
      printStep(`loop: sleeping ${config.backoffMs}ms before next iteration`);
    }
    await new Promise((resolve) => setTimeout(resolve, config.backoffMs));
  }

  if (stop.stopRequested) {
    const loaded = await loadState(config.stateFile);
    const state = loaded.state || {};
    const stoppedState = {
      ...state,
      lastStatus: "stopped",
      updatedAt: new Date().toISOString(),
      startedAt: state.startedAt || new Date().toISOString(),
      history: (state.history || []).concat([`${new Date().toISOString()} stopped by signal`]).slice(-50),
    };
    const progressPayload = formatProgress(stoppedState);
    await writeText(config.progressFile, progressPayload);
    await writeText(config.stateFile, JSON.stringify(stoppedState, null, 2) + "\n");
    await appendActivity(config.activityLog, ["Final status: stopped."]);
    printStep("loop: final status stopped");
  }

  const archiveResult = await archiveCompletedLoop(config);
  if (archiveResult.archived) {
    const prettyArchive = prettyPath(config.cwd, archiveResult.archiveDir);
    printStep(`loop: archived to ${prettyArchive}`);
  }
}

module.exports = {
  runLoop,
};
