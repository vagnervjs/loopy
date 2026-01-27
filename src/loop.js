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
    await appendActivity(config.activityLog, ["Plan complete. Stopping loop."]);
    printStep("Plan complete. Stopping loop.");
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
      `Missing agent_command. Set it in ${prettyPath(config.cwd, config.taskFile)} front matter or use --agent.`
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
    await appendActivity(config.activityLog, ["Plan complete detected after iteration."]);
    printStep("Plan complete detected after iteration.", { iteration });
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
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  if (command === "run") {
    throw new Error("Unsupported command. For a single iteration, use `loopy loop --max-iterations 1`.");
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
  if (!config.gitBranch) {
    let isGitRepo = false;
    try {
      await fs.stat(path.join(baseCwd, ".git"));
      isGitRepo = true;
    } catch (_) {
      isGitRepo = false;
    }
    // If the user is explicitly running in a worktree branch, don't auto-switch
    // away from it by synthesizing a default branch.
    const hasWorktreeBranch = Boolean(String(config.gitWorktreeBranch || "").trim());
    if (isGitRepo && !hasWorktreeBranch) {
      const rawPrompt =
        hasOwn(flags, "prompt") && flags.prompt !== true ? String(flags.prompt || "").trim() : "";
      let base = rawPrompt;
      if (base.startsWith("@")) base = path.basename(base.slice(1).trim() || "seed");
      if (base === "-") base = "stdin";
      base = base.replace(/\.[a-z0-9]+$/i, "");
      const slug = toSlug(base) || toSlug(path.basename(baseCwd)) || "work";
      config.gitBranch = `loopy/${slug}`.slice(0, 80);
    }
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
  // If a worktree branch was specified, don't switch away from it via any default/implicit `gitBranch`.
  // Only honor `gitBranch` when the user explicitly provided it (flag or plan front matter).
  const fm0 = (parsedTask && parsedTask.frontMatter) || {};
  const fmGit = fm0.git && typeof fm0.git === "object" ? fm0.git : {};
  const gitBranchExplicit = Boolean(
    String(flags["git-branch"] || "").trim() ||
      String(fm0.git_branch || fm0.gitBranch || "").trim() ||
      String(fmGit.branch || fmGit.git_branch || fmGit.gitBranch || "").trim()
  );
  if (config.gitWorktree && config.gitWorktreeBranch && !gitBranchExplicit) {
    config.gitBranch = "";
  }
  if (config.gitBranch) {
    printStep(`git branch: switch to ${config.gitBranch}`, {});
    await ensureGitRepo(effectiveCwd);
    await gitSwitchBranch(effectiveCwd, config.gitBranch);
    printStep(`git branch: now on ${config.gitBranch}`, {});
  }

  config = materializeConfigPaths(config, effectiveCwd);
  if (onActivityLog) onActivityLog(config.activityLog);

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
    printStep(`Plan updated before loop: ${prettyPath(config.cwd, config.taskFile)}`, {});
  }

  // Persist key defaults into the plan front matter when missing (agent/test/branch).
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
    if (Object.keys(git).length) next.git = git;
    return next;
  });

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

    // `--dry-run` builds the prompt and skips agent execution. Since dry runs don't
    // advance state iterations, stop after the first iteration to avoid looping
    // forever (and to keep CLI/test behavior fast and predictable).
    if (config.dryRun) {
      await appendActivity(config.activityLog, ["Dry run complete. Stopping."]);
      printStep("Dry run complete. Stopping.");
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
