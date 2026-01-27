const fs = require("fs/promises");
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
const { printStep } = require("./steps");
const { getTaskLine, parseTask, toSlug } = require("./task");
const { redact, truncate, normalizeTaskSeedText } = require("./text");
const { proposePhasesWithAgent, fallbackPhasesFromSeed, renderTaskMarkdown } = require("./auto-phase");
const {
  ensureGitRepo,
  ensureGitWorktree,
  getGitModifiedFiles,
  gitCommitIfNeeded,
  gitSwitchBranch,
} = require("./git");

function parseSkipPhaseList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => toSlug(s) || s.trim())
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function looksLikeLegacyPromptOutFile(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  // These are reserved for seed prompt semantics.
  if (v === "-" || v.startsWith("@")) return false;
  // If there is whitespace, it's far more likely to be an inline seed.
  if (/\s/.test(v)) return false;
  return Boolean(path.extname(v) || v.includes("/") || v.includes("\\"));
}

async function readStdinText() {
  try {
    if (process.stdin.readableEnded) return "";
  } catch (_) {
    // ignore
  }
  return await new Promise((resolve, reject) => {
    let data = "";
    try {
      process.stdin.setEncoding("utf8");
    } catch (_) {
      // ignore
    }
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });
}

async function loadTaskSeed(config) {
  const promptSeedRaw = config.promptSeed == null ? "" : String(config.promptSeed).trim();

  const legacyInlineRaw = config.taskPrompt == null ? "" : String(config.taskPrompt);
  const legacyInline = normalizeTaskSeedText(legacyInlineRaw);
  const legacyFileArg = String(config.taskPromptFile || "").trim();

  if (promptSeedRaw && (legacyInline || legacyFileArg)) {
    throw new Error("Provide only one of --prompt or (--task-prompt / --task-file).");
  }

  // Preferred seed path: `--prompt`
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

  // Legacy seed path: `--task-prompt` / `--task-file`
  if (legacyInline && legacyFileArg) {
    throw new Error("Provide only one of --task-prompt or --task-file.");
  }

  if (legacyFileArg) {
    if (legacyFileArg === "-") {
      const raw = await readStdinText();
      const seed = normalizeTaskSeedText(raw);
      if (!seed) throw new Error("Task prompt from --task-file '-' (stdin) is empty.");
      return { seed, source: "--task-file" };
    }

    const abs = resolveFrom(config.cwd, legacyFileArg);
    let raw = "";
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new Error(`Task prompt file not found: ${prettyPath(config.cwd, abs)}`);
      }
      if (err && err.code === "EISDIR") {
        throw new Error(`Task prompt path is a directory: ${prettyPath(config.cwd, abs)}`);
      }
      if (err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new Error(`Permission denied reading task prompt file: ${prettyPath(config.cwd, abs)}`);
      }
      throw new Error(
        `Failed to read task prompt file ${prettyPath(config.cwd, abs)}: ${err && err.message ? err.message : String(err)}`
      );
    }
    const seed = normalizeTaskSeedText(raw);
    if (!seed) throw new Error(`Task prompt file is empty: ${prettyPath(config.cwd, abs)}`);
    return { seed, source: "--task-file" };
  }

  if (legacyInline) return { seed: legacyInline, source: "--task-prompt" };
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

async function ensureTaskBeforeLoop(config, loadedSeed) {
  const cwd = config.cwd;
  const taskPath = config.taskFile;

  let existing = await readText(taskPath);
  if (!existing) {
    const loaded = loadedSeed || (await loadTaskSeed(config));
    let seed = loaded.seed;
    if (!seed) {
      seed = await promptLine(`Enter a short task description for ${prettyPath(cwd, taskPath)}: `);
    }
    if (!seed) {
      throw new Error(
        `Missing ${prettyPath(cwd, taskPath)} and no seed prompt provided (use --prompt, or legacy --task-prompt/--task-file, or run in a TTY).`
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
        "# Task",
        "",
        `- [ ] ${seed}`,
        "",
      ].join("\n");
    }

    const ok = await confirm(`Write new ${prettyPath(cwd, taskPath)}?`, {
      autoApply: config.autoApply,
      defaultYes: true,
    });
    if (!ok) throw new Error(`Aborted: ${prettyPath(cwd, taskPath)} not created.`);
    await writeText(taskPath, nextText);
    return { taskText: nextText, rewritten: true };
  }

  // User-provided prompt explicitly requests an update.
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
      // Legacy update: overwrite checklist with a single new item.
      nextText = [
        "---",
        yaml.dump(fm, { lineWidth: 120 }).trimEnd(),
        "---",
        "",
        "# Task",
        "",
        `- [ ] ${seed}`,
        "",
      ].join("\n");
    }

    if (nextText !== existing) {
      const ok = await confirm(`Update ${prettyPath(cwd, taskPath)} from ${loaded.source}?`, {
        autoApply: config.autoApply,
        defaultYes: false,
      });
      if (ok) {
        await writeText(taskPath, nextText);
        return { taskText: nextText, rewritten: true };
      }
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
            autoApply: config.autoApply,
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
    await appendActivity(config.activityLog, ["Task complete. Stopping loop."]);
    printStep("Task complete. Stopping loop.");
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
  printStep(`Iteration start (rotation: ${rotationPending ? "fresh" : "standard"}${phaseLabel})`, { iteration });

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
  printStep(`Prompt written to ${prettyPath(config.cwd, config.promptFile)}`, { iteration });

  await appendActivity(config.activityLog, [
    `Iteration ${iteration} start`,
    `Rotation pending: ${rotationPending ? "yes" : "no"}`,
  ]);

  if (config.dryRun) {
    await appendActivity(config.activityLog, ["Dry run enabled. Skipping agent execution."]);
    printStep("Dry run enabled. Skipping agent execution.", { iteration });
    return { status: "dry-run", bytes: bytesRead + bytesWritten };
  }

  if (!config.agentCommand) {
    throw new Error(
      `Missing agent_command. Set it in ${prettyPath(config.cwd, config.taskFile)} front matter or use --agent-cmd.`
    );
  }

  if (config.preIteration) {
    printStep(`Running preIteration hook: ${redact(config.preIteration)}`, { iteration });
    const hookResult = await runShellCommand(config.preIteration, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    await appendActivity(config.activityLog, [`preIteration hook exit ${hookResult.code}`]);
    printStep(`preIteration hook exit ${hookResult.code}`, { iteration });
  }

  const agentStreamLogPath = config.agentStreamLog
    ? resolveFrom(config.cwd, config.agentStreamLog)
    : path.join(config.loopyDir, "agent_stream.log");

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
    `Running agent: ${redact(config.agentCommand)} (stream log: ${prettyPath(config.cwd, agentStreamLogPath)})`,
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

  await writeText(path.join(config.loopyDir, "last_agent_output.txt"), combinedOutput);
  bytesWritten += Buffer.byteLength(combinedOutput);

  let status = agentResult.code === 0 ? "success" : "failure";
  let lastError = "";
  let errorSignature = "";

  if (status === "failure") {
    const firstErrorLine = (redactedStderr || redactedStdout).split(/\r?\n/).find(Boolean) || "unknown";
    lastError = firstErrorLine;
    errorSignature = `${config.agentCommand}::${firstErrorLine}`;
    printStep(`Agent exit ${agentResult.code} (error: ${lastError})`, { iteration });
  } else {
    printStep(`Agent exit ${agentResult.code}`, { iteration });
  }

  let testStatus = "n/a";
  const effectiveTestCommand = currentPhaseId ? phaseTestCommand(parsedTask, currentPhaseId) : config.testCommand;
  if (status === "success" && effectiveTestCommand) {
    printStep(`Running tests: ${redact(effectiveTestCommand)}`, { iteration });
    const testResult = await runShellCommand(effectiveTestCommand, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    const testOutput = truncate(redact(`${testResult.stdout}\n${testResult.stderr}`), DEFAULTS.maxOutputBytes);
    await writeText(path.join(config.loopyDir, "last_test_output.txt"), testOutput);
    bytesWritten += Buffer.byteLength(testOutput);
    const testOutcome = testResult.code === 0 ? "pass" : "fail";
    testStatus = `${testOutcome} @ ${new Date().toISOString()}`;
    printStep(`Test result: ${testOutcome}`, { iteration });
    if (testOutcome === "fail") {
      status = "failure";
      lastError = testOutput.split(/\r?\n/).find(Boolean) || "test failure";
      errorSignature = `${effectiveTestCommand}::${lastError}`;
    }
  }

  const taskAfter = await readText(config.taskFile);
  bytesRead += Buffer.byteLength(taskAfter);
  const taskComplete = taskAfter ? parseTask(taskAfter).allChecked : false;
  const taskLine = getTaskLine(taskAfter || taskText, { phaseId: currentPhaseId });
  const taskContext = extractChangeType(taskLine);
  const taskSummary = taskContext.summary;
  let changeType = taskContext.changeType;
  if (taskContext.changeType === "chore" && !/^[a-zA-Z]+\s*:/.test(taskLine || "")) {
    const agentType = await inferChangeTypeFromAgent(config.agentCommand, taskLine);
    changeType = agentType || inferChangeTypeHeuristic(taskLine);
  }
  await appendActivity(config.activityLog, [`change_type inferred: ${changeType} (task: ${taskLine})`]);
  console.log(`change_type: ${changeType} (task: ${taskLine})`);

  let postIterationRan = false;
  if (status === "success" && config.postIteration) {
    printStep(`Running postIteration hook: ${redact(config.postIteration)}`, { iteration });
    const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    postIterationRan = true;
    await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
    printStep(`postIteration hook exit ${hookResult.code}`, { iteration });
  }

  if (status === "success") {
    try {
      if (config.gitCommit) {
        printStep("Git commit enabled; checking for changes.", { iteration });
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
        printStep(`Git commit created: ${commitResult.hash || "(unknown hash)"}`, { iteration });
      } else if (config.gitCommit) {
        printStep(`Git commit skipped: ${commitResult.reason}`, { iteration });
      }
    } catch (err) {
      status = "failure";
      lastError = err && err.message ? err.message : String(err);
      errorSignature = `git commit::${lastError}`;
      printStep(`Git commit failed: ${lastError}`, { iteration });
    }
  }

  if (status === "failure" && config.onFailure) {
    printStep(`Running onFailure hook: ${redact(config.onFailure)}`, { iteration });
    const hookResult = await runShellCommand(config.onFailure, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    await appendActivity(config.activityLog, [`onFailure hook exit ${hookResult.code}`]);
    printStep(`onFailure hook exit ${hookResult.code}`, { iteration });
  }

  if (!postIterationRan && config.postIteration) {
    printStep(`Running postIteration hook: ${redact(config.postIteration)}`, { iteration });
    const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
    printStep(`postIteration hook exit ${hookResult.code}`, { iteration });
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
    printStep(`Guardrail stop: ${guardrailStopReason}`, { iteration });
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
    `State updated: ${prettyPath(config.cwd, config.stateFile)} (status: ${nextState.lastStatus}, test: ${nextState.lastTest})`,
    { iteration }
  );

  await appendActivity(config.activityLog, [
    `Iteration ${iteration} ${status}`,
    `Bytes read/written: ${bytesRead}/${bytesWritten}`,
  ]);

  if (taskComplete) {
    await appendActivity(config.activityLog, ["Task complete detected after iteration."]);
    printStep("Task complete detected after iteration.", { iteration });
    return { status: "complete", bytes: bytesRead + bytesWritten };
  }

  if (nextState.lastStatus === "phase-complete") {
    await appendActivity(config.activityLog, [`Phase complete (${currentPhaseId}); --phase-only stopping.`]);
    printStep(`Phase complete (${currentPhaseId}); --phase-only stopping.`, { iteration });
    return { status: "complete", bytes: bytesRead + bytesWritten };
  }

  printStep(`Iteration result: ${status} (test: ${testStatus})`, { iteration });
  return { status, bytes: bytesRead + bytesWritten, guardrailStopReason };
}

async function runLoop(command, flags, { stopSignal, onActivityLog } = {}) {
  const stop = stopSignal || { stopRequested: false };
  const baseCwd = process.cwd();
  const explicitTask = Object.prototype.hasOwnProperty.call(flags, "task");
  const defaultTaskPath = resolveFrom(baseCwd, flags.task || DEFAULTS.taskFile);
  let initialTaskPath = defaultTaskPath;
  let taskText = await readText(initialTaskPath);

  // Back-compat: if LOOPY_PLAN.md is missing and LOOPY_TASK.md exists, use it and warn.
  if (!explicitTask && !taskText) {
    const legacyPath = resolveFrom(baseCwd, "LOOPY_TASK.md");
    const legacyText = await readText(legacyPath);
    if (legacyText) {
      initialTaskPath = legacyPath;
      taskText = legacyText;
      console.error(
        "Warning: `LOOPY_TASK.md` is deprecated. Rename it to `LOOPY_PLAN.md` (or run with `--task LOOPY_TASK.md`)."
      );
    }
  }

  const parsedTask = taskText ? parseTask(taskText) : { frontMatter: {} };
  let config = mergeConfig(flags, parsedTask.frontMatter);

  // Ensure config points at the same file we used for front matter.
  if (!explicitTask && initialTaskPath !== defaultTaskPath) {
    config.taskFile = path.relative(baseCwd, initialTaskPath) || initialTaskPath;
  }

  // Deprecation warnings.
  if (Object.prototype.hasOwnProperty.call(flags, "task-prompt")) {
    console.error("Warning: `--task-prompt` is deprecated. Use `--prompt` instead.");
  }
  if (Object.prototype.hasOwnProperty.call(flags, "task-file") || Object.prototype.hasOwnProperty.call(flags, "task-prompt-file")) {
    console.error("Warning: `--task-file` is deprecated. Use `--prompt @<file>` (or `--prompt -`) instead.");
  }
  if (Object.prototype.hasOwnProperty.call(flags, "prompt-file")) {
    console.error("Warning: `--prompt-file` is deprecated. Use `--prompt-out` instead.");
  }

  const legacySeedProvided =
    Object.prototype.hasOwnProperty.call(flags, "task-prompt") ||
    Object.prototype.hasOwnProperty.call(flags, "task-file") ||
    Object.prototype.hasOwnProperty.call(flags, "task-prompt-file");
  const promptIsLegacyOutAlias =
    legacySeedProvided &&
    !Object.prototype.hasOwnProperty.call(flags, "prompt-out") &&
    !Object.prototype.hasOwnProperty.call(flags, "prompt-file") &&
    Object.prototype.hasOwnProperty.call(flags, "prompt") &&
    flags.prompt !== true &&
    looksLikeLegacyPromptOutFile(flags.prompt);

  if (promptIsLegacyOutAlias) {
    console.error("Warning: `--prompt <file>` is deprecated. Use `--prompt-out <file>` instead.");
    if (flags.prompt === true) {
      throw new Error("Missing value for --prompt (expected a prompt output file path).");
    }
    const v = String(flags.prompt || "").trim();
    if (!v) throw new Error("Missing value for --prompt (expected a prompt output file path).");
  } else {
    // Validate new seed prompt flag early.
    if (Object.prototype.hasOwnProperty.call(flags, "prompt")) {
      if (flags.prompt === true) {
        throw new Error("Missing value for --prompt (expected text, @<file>, or '-').");
      }
      const v = String(flags.prompt || "").trim();
      if (!v) throw new Error("Missing value for --prompt (expected text, @<file>, or '-').");
      if (v.startsWith("@") && !v.slice(1).trim()) {
        throw new Error("Missing file path after --prompt @<file>.");
      }
    }
  }

  // Validate prompt output alias flags.
  if (flags["prompt-out"] === true) {
    throw new Error("Missing value for --prompt-out (expected a file path).");
  }
  if (flags["prompt-file"] === true) {
    throw new Error("Missing value for --prompt-file (expected a file path).");
  }

  if (Object.prototype.hasOwnProperty.call(flags, "task-prompt") && flags["task-prompt"] !== true) {
    const v = String(flags["task-prompt"] || "").trim();
    if (!v) throw new Error("Missing value for --task-prompt (expected text).");
  }
  if (flags["task-prompt"] === true) {
    throw new Error("Missing value for --task-prompt (expected text).");
  }
  if (
    (Object.prototype.hasOwnProperty.call(flags, "task-file") && flags["task-file"] !== true) ||
    (Object.prototype.hasOwnProperty.call(flags, "task-prompt-file") && flags["task-prompt-file"] !== true)
  ) {
    const raw = String((flags["task-file"] ?? flags["task-prompt-file"]) || "").trim();
    if (!raw) throw new Error("Missing value for --task-file (expected a file path or '-').");
  }
  if (flags["task-file"] === true || flags["task-prompt-file"] === true) {
    throw new Error("Missing value for --task-file (expected a file path or '-').");
  }

  printStep(
    `Starting ${command} (max iterations: ${config.maxIterations}, max minutes: ${config.maxMinutes}, backoff ms: ${config.backoffMs})`
  );

  // Optional git workspace setup (worktree / branch). This is done once, before the loop.
  let effectiveCwd = baseCwd;
  if (config.gitWorktree) {
    printStep(
      `git worktree: ensure ${prettyPath(baseCwd, resolveFrom(baseCwd, config.gitWorktree))}` +
        (config.gitWorktreeBranch ? ` (branch: ${config.gitWorktreeBranch})` : " (detached)"),
      {}
    );
    effectiveCwd = await ensureGitWorktree(baseCwd, config.gitWorktree, config.gitWorktreeBranch);
    printStep(`git worktree: using ${prettyPath(baseCwd, effectiveCwd)}`, {});
  }
  if (config.gitBranch) {
    printStep(`git branch: switch to ${config.gitBranch}`, {});
    await ensureGitRepo(effectiveCwd);
    await gitSwitchBranch(effectiveCwd, config.gitBranch);
    printStep(`git branch: now on ${config.gitBranch}`, {});
  }

  config = materializeConfigPaths(config, effectiveCwd);
  if (onActivityLog) onActivityLog(config.activityLog);

  // Load the task seed once so stdin ('-') works and prompts can reuse the content.
  const loadedSeed = await loadTaskSeed(config);
  config.taskSeedText = loadedSeed.seed || "";
  config.taskSeedSource = loadedSeed.source || "";

  // Task initialization / auto-phase planning happens once, before looping.
  const ensured = await ensureTaskBeforeLoop(config, loadedSeed);
  if (ensured.rewritten) {
    await appendActivity(config.activityLog, [
      `Task updated before loop: ${prettyPath(config.cwd, config.taskFile)}`,
    ]);
    printStep(`Task updated before loop: ${prettyPath(config.cwd, config.taskFile)}`, {});
  }

  const start = Date.now();
  let iteration = 0;

  while (!stop.stopRequested) {
    const elapsedMinutes = (Date.now() - start) / 60000;
    if (iteration >= config.maxIterations) {
      await appendActivity(config.activityLog, ["Max iterations reached. Stopping."]);
      printStep("Max iterations reached. Stopping.");
      break;
    }
    if (elapsedMinutes >= config.maxMinutes) {
      await appendActivity(config.activityLog, [
        `Max wall time reached (${formatDuration(config.maxMinutes)}). Stopping.`,
      ]);
      printStep(`Max wall time reached (${formatDuration(config.maxMinutes)}). Stopping.`);
      break;
    }

    const result = await runIteration(config);
    iteration += 1;

    if (result.status === "complete") {
      break;
    }

    if (result.guardrailStopReason) {
      await appendActivity(config.activityLog, [`Guardrail stop triggered: ${result.guardrailStopReason}`]);
      printStep(`Guardrail stop triggered: ${result.guardrailStopReason}`);
      break;
    }

    if (stop.stopRequested) {
      await appendActivity(config.activityLog, ["Stop requested. Exiting loop."]);
      printStep("Stop requested. Exiting loop.");
      break;
    }

    if (command === "run") {
      break;
    }

    if (config.backoffMs > 0) {
      printStep(`Sleeping ${config.backoffMs}ms before next iteration...`);
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
    printStep("Final status: stopped.");
  }
}

module.exports = {
  runIteration,
  runLoop,
};
