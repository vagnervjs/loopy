const path = require("path");
const yaml = require("js-yaml");

const { appendActivity } = require("../activity");
const { DEFAULTS, prettyPath } = require("../config");
const { confirm, promptLine } = require("../confirm");
const { readText, writeText } = require("../fs");
const { ensureGuardrails, formatPrompt } = require("../prompt");
const { printStep } = require("../steps");
const { getCurrentPhaseSection, getCurrentTask, parseTask, resolvePrdRefsForCurrentTask } = require("../task");
const { redact, truncate } = require("../text");
const { fallbackPhasesFromSeed, proposePhasesWithAgent, renderTaskMarkdown, sanitizeControlChars } = require("../auto-phase");
const { pickCurrentPhaseId } = require("./phases");
const { loadTaskSeed } = require("./seed");

const PLAN_OUTPUT_FILE = "last_plan_output.txt";

async function recordPlanGenerationFailure(config, { output, stdout, stderr, error, seedSource }) {
  const logPath = path.join(config.loopyDir, PLAN_OUTPUT_FILE);
  const safeStdout = sanitizeControlChars(stdout || output || "");
  const safeStderr = sanitizeControlChars(stderr || "");
  const header = [
    "# Loopy Plan Generation Output",
    "",
    `Timestamp: ${new Date().toISOString()}`,
    `Error: ${error || "unknown"}`,
    `Seed source: ${seedSource || "unknown"}`,
    "",
  ].join("\n");
  const payload = [
    header,
    "STDOUT:",
    safeStdout ? truncate(String(safeStdout), DEFAULTS.maxOutputBytes) : "(no stdout)",
    "",
    "STDERR:",
    safeStderr ? truncate(String(safeStderr), DEFAULTS.maxOutputBytes) : "(no stderr)",
    "",
  ].join("\n");
  await writeText(logPath, payload);
  await appendActivity(config.activityLog, [
    `plan generation failed: ${error || "unknown"} (see ${prettyPath(config.cwd, logPath)})`,
  ]);
}

function isImplementationTaskText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (/\b(analysis|analyze|analyzing|analysing|research|spike|document|documentation|docs?|readme|changelog|license)\b/.test(text)) {
    return false;
  }
  return true;
}

function collectMissingPrdRefs(parsedTask) {
  const missing = [];
  if (!parsedTask || !Array.isArray(parsedTask.checklist) || !parsedTask.checklist.length) return missing;
  if (Array.isArray(parsedTask.phases) && parsedTask.phases.length) {
    for (const phase of parsedTask.phases) {
      const phaseId = String((phase && phase.id) || "").trim();
      if (!phaseId) continue;
      const sec = parsedTask.phaseSections && parsedTask.phaseSections[phaseId];
      const list = sec && Array.isArray(sec.checklist) ? sec.checklist : [];
      for (const item of list) {
        if (!item || !isImplementationTaskText(item.text)) continue;
        const refs = resolvePrdRefsForCurrentTask(parsedTask, phaseId, item);
        if (!Array.isArray(refs) || refs.length === 0) {
          missing.push({ phaseId, task: String(item.text || "").trim() });
        }
      }
    }
    return missing;
  }
  for (const item of parsedTask.checklist) {
    if (!item || !isImplementationTaskText(item.text)) continue;
    const refs = resolvePrdRefsForCurrentTask(parsedTask, "", item);
    if (!Array.isArray(refs) || refs.length === 0) {
      missing.push({ phaseId: "", task: String(item.text || "").trim() });
    }
  }
  return missing;
}

function derivePrdRefsDefaults(prdText) {
  const text = String(prdText || "");
  const refs = [];
  const headings = text.match(/^#{1,6}\s+(.+)$/gm) || [];
  for (const line of headings) {
    const section = String(line || "").replace(/^#{1,6}\s+/, "").trim();
    if (!section) continue;
    if (/^prd\b/i.test(section)) continue;
    refs.push({ section });
    if (refs.length >= 6) break;
  }
  if (refs.length) return refs;
  return [{ section: "Goals" }, { section: "Acceptance Criteria" }];
}

function upsertPrdRefsDefaults(taskText, refs) {
  const text = String(taskText || "");
  const defaults = Array.isArray(refs) ? refs : [];
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  let fm = {};
  let body = text;
  if (match) {
    try {
      fm = yaml.load(match[1]) || {};
    } catch (_) {
      fm = {};
    }
    body = text.slice(match[0].length);
  }
  fm = fm && typeof fm === "object" ? { ...fm } : {};
  if (!Array.isArray(fm.prd_refs_defaults) || !fm.prd_refs_defaults.length) {
    fm.prd_refs_defaults = defaults;
  }
  const yamlText = yaml.dump(fm, { lineWidth: 120 }).trimEnd();
  const normalizedBody = String(body || "").replace(/^\n+/, "");
  return ["---", yamlText, "---", "", normalizedBody].join("\n");
}

async function enforcePrdRefsCoverage(config) {
  const taskText = await readText(config.taskFile);
  if (!taskText) return { changed: false, missing: [] };
  const parsed = parseTask(taskText);
  const missing = collectMissingPrdRefs(parsed);
  if (!missing.length) return { changed: false, missing: [] };

  const prdText = await readText(config.prdFile);
  const defaults = derivePrdRefsDefaults(prdText);
  const nextText = upsertPrdRefsDefaults(taskText, defaults);
  if (nextText !== taskText) {
    await writeText(config.taskFile, nextText);
  }

  const reParsed = parseTask(nextText);
  const remaining = collectMissingPrdRefs(reParsed);
  if (remaining.length) {
    const sample = remaining.slice(0, 3).map((entry) => entry.phaseId ? `[${entry.phaseId}] ${entry.task}` : entry.task).join("; ");
    throw new Error(`Plan requires PRD references for implementation tasks. Missing refs: ${sample}`);
  }
  return { changed: nextText !== taskText, missing };
}

async function ensureTaskBeforeLoop(config, loadedSeed, { stopSignal } = {}) {
  const cwd = config.cwd;
  const taskPath = config.taskFile;
  const shouldStop = () => Boolean(stopSignal && stopSignal.stopRequested);
  const phaseAgentLabel = config.agentCommand ? ` with ${redact(config.agentCommand)}` : "";
  const logPhasePlan = () => {
    printStep(`Generating phase plan${phaseAgentLabel}`, { kind: "plan" });
  };

  let existing = await readText(taskPath);
  if (shouldStop()) {
    return { taskText: existing || "", rewritten: false, aborted: true };
  }
  if (!existing) {
    const loaded = loadedSeed || (await loadTaskSeed(config));
    let seed = loaded.seed;
    const seedSource = loaded.source || "interactive";
    if (!seed) {
      seed = await promptLine(`Enter a short plan description for ${prettyPath(cwd, taskPath)}: `);
    }
    if (!seed) {
      throw new Error(
        `Missing ${prettyPath(cwd, taskPath)} and no seed prompt provided (use --prompt, or run in a TTY).`
      );
    }

    let testCommand = config.testCommand;
    if (!String(testCommand || "").trim()) {
      if (!process.stdin.isTTY) {
        throw new Error("Missing test command for plan (set test_command in plan front matter or config).");
      }
      testCommand = await promptLine("Enter test command for this plan (required): ");
    }
    testCommand = String(testCommand || "").trim();
    if (!testCommand) {
      throw new Error("Missing test command for plan (required).");
    }

    // If auto-phase is on, try to generate phases; otherwise create a minimal legacy task file.
    let nextText = "";
    if (config.autoPhase) {
      logPhasePlan();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed, {
        noColor: config.noColor,
        stopSignal,
        streamToTerminal: Boolean(config.stream),
      });
      if (proposed.aborted || shouldStop()) {
        return { taskText: "", rewritten: false, aborted: true };
      }
      if (!proposed.ok) {
        await recordPlanGenerationFailure(config, {
          output: proposed.output,
          stdout: proposed.stdout,
          stderr: proposed.stderr,
          error: proposed.error,
          seedSource,
        });
      }
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : fallbackPhasesFromSeed(seed, { testCommand });
      if (!plan.phaseDefaults || typeof plan.phaseDefaults !== "object") {
        plan.phaseDefaults = {};
      }
      if (!String(plan.phaseDefaults.test_command || plan.phaseDefaults.testCommand || "").trim()) {
        plan.phaseDefaults.test_command = testCommand;
      }
      const fm = {
        agent_command: config.agentCommand || "",
        test_command: testCommand,
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
            test_command: testCommand,
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
    let testCommand = config.testCommand || fm.test_command || fm.testCommand || "";
    if (!String(testCommand || "").trim()) {
      if (!process.stdin.isTTY) {
        throw new Error("Missing test command for plan update (set test_command in plan front matter or config).");
      }
      testCommand = await promptLine("Enter test command for this plan (required): ");
    }
    testCommand = String(testCommand || "").trim();
    if (!testCommand) {
      throw new Error("Missing test command for plan update (required).");
    }

    let nextText = existing;
    if (config.autoPhase) {
      logPhasePlan();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed, {
        noColor: config.noColor,
        stopSignal,
        streamToTerminal: Boolean(config.stream),
      });
      if (proposed.aborted || shouldStop()) {
        return { taskText: existing, rewritten: false, aborted: true };
      }
      if (!proposed.ok) {
        await recordPlanGenerationFailure(config, {
          output: proposed.output,
          error: proposed.error,
          seedSource: loaded.source || "--prompt",
        });
      }
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : fallbackPhasesFromSeed(seed, { testCommand });
      if (!plan.phaseDefaults || typeof plan.phaseDefaults !== "object") {
        plan.phaseDefaults = {};
      }
      if (!String(plan.phaseDefaults.test_command || plan.phaseDefaults.testCommand || "").trim()) {
        plan.phaseDefaults.test_command = testCommand;
      }
      if (!String(fm.test_command || fm.testCommand || "").trim()) {
        fm.test_command = testCommand;
      }
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
      logPhasePlan();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed, {
        noColor: config.noColor,
        stopSignal,
        streamToTerminal: Boolean(config.stream),
      });
      if (proposed.aborted || shouldStop()) {
        return { taskText: existing, rewritten: false, aborted: true };
      }
      if (!proposed.ok) {
        await recordPlanGenerationFailure(config, {
          output: proposed.output,
          stdout: proposed.stdout,
          stderr: proposed.stderr,
          error: proposed.error,
          seedSource: "plan-doc",
        });
      }
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : null;
      if (plan) {
        let testCommand = config.testCommand || parsed.frontMatter.test_command || parsed.frontMatter.testCommand || "";
        if (!String(testCommand || "").trim()) {
          if (!process.stdin.isTTY) {
            throw new Error("Missing test command for plan (set test_command in plan front matter or config).");
          }
          testCommand = await promptLine("Enter test command for this plan (required): ");
        }
        testCommand = String(testCommand || "").trim();
        if (!testCommand) {
          throw new Error("Missing test command for plan (required).");
        }
        if (!plan.phaseDefaults || typeof plan.phaseDefaults !== "object") {
          plan.phaseDefaults = {};
        }
        if (!String(plan.phaseDefaults.test_command || plan.phaseDefaults.testCommand || "").trim()) {
          plan.phaseDefaults.test_command = testCommand;
        }
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

async function writePromptPreview(config) {
  const taskText = await readText(config.taskFile);
  if (!taskText) {
    throw new Error(`Missing ${prettyPath(config.cwd, config.taskFile)}.`);
  }
  const parsedTask = parseTask(taskText);

  let guardrailsText = await readText(config.guardrailsFile);
  const ensuredGuardrails = ensureGuardrails(guardrailsText);
  if (ensuredGuardrails !== guardrailsText) {
    await writeText(config.guardrailsFile, ensuredGuardrails);
    guardrailsText = ensuredGuardrails;
  }

  const progressText = await readText(config.progressFile);
  const hintsTextRaw = await readText(config.hintsFile);
  const hintsText = truncate(hintsTextRaw, 8000);

  const currentPhaseId = pickCurrentPhaseId(parsedTask, {}, config, { phaseExplicit: false });
  const currentTaskObj = getCurrentTask(taskText, { phaseId: currentPhaseId });
  const currentTaskText = currentTaskObj ? currentTaskObj.text.trim() : null;
  const filteredPlan = currentPhaseId ? getCurrentPhaseSection(taskText, currentPhaseId) : taskText;
  const prdRefs = resolvePrdRefsForCurrentTask(parsedTask, currentPhaseId, currentTaskObj);

  const prompt = formatPrompt({
    iteration: 0,
    taskText,
    taskSeedText: config.taskSeedText || "",
    taskSeedSource: config.taskSeedSource || "",
    guardrailsText,
    progressText: progressText || "(no progress recorded yet)",
    lastOutput: "",
    rotationPending: false,
    currentPhase: currentPhaseId,
    taskFilePath: config.taskFile,
    hintsText,
    prdRefs,
    currentTask: currentTaskText,
    filteredPlan,
    promptTemplate: config.promptTemplateText || "",
  });

  await writeText(config.promptFile, prompt);
  printStep(`Prompt saved to ${prettyPath(config.cwd, config.promptFile)}`, { kind: "prompt" });
}

module.exports = {
  enforcePrdRefsCoverage,
  ensureTaskBeforeLoop,
  recordPlanGenerationFailure,
  writePromptPreview,
};
