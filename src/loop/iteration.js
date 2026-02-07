const fs = require("fs/promises");
const path = require("path");

const { appendActivity } = require("../activity");
const { extractChangeType, inferChangeTypeFromAgent, inferChangeTypeHeuristic } = require("../change-type");
const { DEFAULTS, prettyPath, resolveFrom } = require("../config");
const { readText, writeText } = require("../fs");
const { detectRepeatFailure, detectThrash } = require("../guardrails");
const { formatProgress, ensureGuardrails, appendSign, formatPrompt } = require("../prompt");
const { runShellCommand } = require("../shell");
const { Spinner } = require("../spinner");
const { loadState } = require("../state");
const { endIteration, printBlankLine, printStep, startIteration } = require("../steps");
const {
  detectMultiTaskCompletion,
  detectPhaseCrossing,
  getCurrentPhaseSection,
  getCurrentTask,
  getTaskLine,
  parseTask,
} = require("../task");
const { formatLocalTimestamp, redact, truncate } = require("../text");
const { ensureGitRepo, gitCommitIfNeeded, getGitModifiedFiles, normalizeGitPath, isPathInsideDir, resolveExcludedArtifactDirs } = require("../git");
const { ensureAgentsDoc } = require("./agents-doc");
const { areAllPhasesComplete, pickCurrentPhaseId, resolvePhaseLabel, phaseTestCommand, isPhaseComplete, computeNextPhaseId } = require("./phases");
const {
  findNewlyCompletedTasks,
  formatCompletedTaskLines,
  formatProgressLine,
  printStepLines,
  summarizePlanProgress,
} = require("./plan-overview");
const { buildSpecsSummary } = require("./specs");

const NON_CODE_EXTENSIONS = new Set([
  ".adoc",
  ".asciidoc",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".md",
  ".mdx",
  ".org",
  ".pdf",
  ".png",
  ".rst",
  ".svg",
  ".txt",
  ".webp",
]);

const NON_CODE_BASENAMES = new Set([
  "authors",
  "changelog",
  "codeowners",
  "copying",
  "license",
  "notice",
  "readme",
]);

function isCodeLikePath(filePath) {
  const normalized = normalizeGitPath(filePath);
  if (!normalized) return false;
  const basename = path.posix.basename(normalized).toLowerCase();
  const basenameWithoutExt = basename.replace(/\.[^.]+$/, "");
  if (NON_CODE_BASENAMES.has(basename) || NON_CODE_BASENAMES.has(basenameWithoutExt)) return false;
  const ext = path.posix.extname(basename).toLowerCase();
  if (ext && NON_CODE_EXTENSIONS.has(ext)) return false;
  return true;
}

function isExplicitNonCodeTask(changeType, taskLine) {
  const normalizedType = String(changeType || "").trim().toLowerCase();
  const normalizedTask = String(taskLine || "").trim().toLowerCase();
  if (normalizedType === "docs") return true;
  return /\b(analysis|analyze|analyzing|analysing|research|spike|documentation|docs?|readme)\b/.test(normalizedTask);
}

function currentPhaseRequiresTestsPass(parsedTask, phaseId) {
  if (!parsedTask || !phaseId) return false;
  const phase = (parsedTask.phases || []).find((item) => item && item.id === phaseId);
  const stopOn = phase && Array.isArray(phase.stopOn) ? phase.stopOn : [];
  return stopOn.some((item) => String(item || "").trim().toLowerCase() === "tests_pass");
}

async function shouldRunTestsForIteration(config, parsedTaskAfter, currentPhaseId, taskContext, effectiveTestCommand) {
  if (!effectiveTestCommand) return { run: false, reason: "missing test command" };
  if (currentPhaseRequiresTestsPass(parsedTaskAfter, currentPhaseId)) {
    return { run: true, reason: "phase requires tests_pass" };
  }

  try {
    await ensureGitRepo(config.cwd);
  } catch (_) {
    if (isExplicitNonCodeTask(taskContext.changeType, taskContext.taskLine)) {
      return { run: false, reason: "no code changes detected" };
    }
    return { run: true, reason: "git unavailable; running tests" };
  }

  const excludedArtifactDirs = resolveExcludedArtifactDirs(config).map(normalizeGitPath).filter(Boolean);
  const changedFiles = (await getGitModifiedFiles(config.cwd)).map(normalizeGitPath).filter(Boolean);
  const relevantFiles = changedFiles.filter(
    (filePath) => !excludedArtifactDirs.some((dirPath) => isPathInsideDir(filePath, dirPath))
  );

  if (!relevantFiles.length) return { run: false, reason: "no code changes detected" };

  const hasCodeChanges = relevantFiles.some((filePath) => isCodeLikePath(filePath));
  if (!hasCodeChanges) return { run: false, reason: "no code changes detected" };

  return { run: true, reason: "code changes detected" };
}

async function runIteration(config, { stopSignal } = {}) {
  let bytesRead = 0;
  let bytesWritten = 0;
  const guardrailStopReasons = [];
  let guardrailCooldownMs = 0;
  let iterationStatus = "failure";
  let testStatus = "n/a";

  const taskText = await readText(config.taskFile);
  bytesRead += Buffer.byteLength(taskText);
  if (!taskText) {
    throw new Error(`Missing ${config.taskFile}.`);
  }

  const parsedTask = parseTask(taskText);

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

  if (parsedTask.allChecked && areAllPhasesComplete(parsedTask, state)) {
    await appendActivity(config.activityLog, ["Plan complete. Stopping loop."]);
    printStep(`Plan complete; stopping loop`, { kind: "plan" });
    return { status: "complete", bytes: 0 };
  }

  const iteration = (state.iteration || 0) + 1;
  const rotationPending = Boolean(state.rotatePending);

  const currentPhaseId = pickCurrentPhaseId(parsedTask, state || {}, config, {
    phaseExplicit: Boolean(config.phaseExplicit),
  });
  const phaseLabel = resolvePhaseLabel(parsedTask, currentPhaseId);
  const iterationStartedAt = new Date();
  startIteration({ iteration, phase: phaseLabel, startedAt: iterationStartedAt });
  const abortIteration = async (label) => {
    const suffix = label ? `; ${label}` : "";
    iterationStatus = "stopped";
    const message = `Stop requested; aborting iteration${suffix}`;
    printStep(message, { iteration, kind: "result", level: "warn" });

    // Ensure agent running state is cleared on abort
    try {
      const abortedState = { ...state, isAgentRunning: false };
      await writeText(config.stateFile, JSON.stringify(abortedState, null, 2) + "\n");
    } catch (_) {
      // ignore
    }

    try {
      await appendActivity(config.activityLog, [message]);
    } catch (_) {
      // ignore
    }
    return { status: "stopped", bytes: bytesRead + bytesWritten };
  };
  try {
    printStep(`Rotation ${rotationPending ? "fresh" : "standard"}`, { iteration, kind: "meta" });

    let lastOutput = "";
    if (config.includeLastOutput && !rotationPending) {
      const lastOutputRaw = await readText(path.join(config.loopyDir, "last_agent_output.txt"));
      bytesRead += Buffer.byteLength(lastOutputRaw);
      lastOutput = truncate(lastOutputRaw, 4000);
    }

    const hintsTextRaw = await readText(config.hintsFile);
    bytesRead += Buffer.byteLength(hintsTextRaw);
    const hintsText = truncate(hintsTextRaw, 8000);

    const specsSummary = await buildSpecsSummary(config.cwd);
    const agentsDoc = await ensureAgentsDoc(config, { stopSignal });

    const currentTaskObj = getCurrentTask(taskText, { phaseId: currentPhaseId });
    const currentTaskText = currentTaskObj ? currentTaskObj.text.trim() : null;
    const filteredPlan = currentPhaseId ? getCurrentPhaseSection(taskText, currentPhaseId) : taskText;

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
      agentsText: agentsDoc.text || "",
      specsText: specsSummary || "",
      currentTask: currentTaskText,
      filteredPlan,
      promptTemplate: config.promptTemplateText || "",
    });

    await writeText(config.promptFile, prompt);
    bytesWritten += Buffer.byteLength(prompt);
    printStep(`Prompt saved to ${prettyPath(config.cwd, config.promptFile)}`, { iteration, kind: "prompt" });

    await appendActivity(config.activityLog, [
      `Iteration ${iteration} start`,
      `Rotation pending: ${rotationPending ? "yes" : "no"}`,
    ]);

    if (config.dryRun) {
      await appendActivity(config.activityLog, ["Dry run enabled. Skipping agent execution."]);
      printStep("Dry run enabled; skipping agent run", { iteration, kind: "result", level: "warn" });
      iterationStatus = "dry-run";
      return { status: "dry-run", bytes: bytesRead + bytesWritten };
    }

    if (!config.agentCommand) {
      throw new Error(
        `Missing agent_command. Set it in ${prettyPath(config.cwd, config.taskFile)} front matter or use --agent.`
      );
    }

    if (config.preIteration) {
      printStep(`Hook pre-iteration run ${redact(config.preIteration)}`, { iteration, kind: "hook" });
      const hookResult = await runShellCommand(config.preIteration, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
        noColor: config.noColor,
        stopSignal,
      });
      if (hookResult.aborted) {
        return await abortIteration("pre-iteration hook");
      }
      await appendActivity(config.activityLog, [`preIteration hook exit ${hookResult.code}`]);
      printStep(`Hook pre-iteration exit ${hookResult.code}`, { iteration, kind: "hook" });
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
      `Agent run ${redact(config.agentCommand)}`,
      { iteration, kind: "agent" }
    );

    // Set agent running state to true before request and show spinner
    const agentRunningState = { ...state, isAgentRunning: true };
    await writeText(config.stateFile, JSON.stringify(agentRunningState, null, 2) + "\n");

    const spinnerBaseText = "Agent at work...";
    const spinnerText =
      config.plain || config.noEmoji ? spinnerBaseText : `🤖 ${spinnerBaseText}`;
    const spinner = new Spinner(spinnerText, {
      plain: config.plain,
      noEmoji: config.noEmoji,
    });
    spinner.start();
    printBlankLine();

    const agentResult = await runShellCommand(config.agentCommand, prompt, DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
      agentStreamLogPath,
      streamToTerminal: Boolean(config.stream),
      noColor: config.noColor,
      stopSignal,
    });

    // Set agent running state to false after request completes and hide spinner
    spinner.stop();
    const agentCompletedState = { ...state, isAgentRunning: false };
    await writeText(config.stateFile, JSON.stringify(agentCompletedState, null, 2) + "\n");

    if (agentResult.aborted) {
      return await abortIteration("agent run");
    }
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
        `Agent exit ${agentResult.code}; error: ${lastError} (see ${prettyPath(
          config.cwd,
          lastAgentOutputPath
        )})`,
        { iteration, level: "error", kind: "agent" }
      );
    } else {
      printStep(`Agent exit ${agentResult.code}`, { iteration, kind: "agent" });
    }

    const taskAfter = await readText(config.taskFile);
    bytesRead += Buffer.byteLength(taskAfter);
    const parsedTaskAfter = taskAfter ? parseTask(taskAfter) : parsedTask;

    // Check for multi-task completion violation (only when single-task mode is enabled)
    if (status === "success" && config.singleTaskMode) {
      const multiTaskDetected = detectMultiTaskCompletion(taskText, taskAfter, parsedTask, parsedTaskAfter);
      if (multiTaskDetected) {
        status = "failure";
        // Determine if phase boundary was crossed
        const hasPhaseCrossing = detectPhaseCrossing(taskText, taskAfter);
        lastError = hasPhaseCrossing
          ? "Multiple phases crossed in single iteration (single-task mode enforced)"
          : "Multiple tasks completed in single iteration (single-task mode enforced)";
        errorSignature = "multi-task-violation";
        printStep(
          `Multi-task violation: ${lastError}`,
          { iteration, level: "error", kind: "enforcement" }
        );
        await appendActivity(config.activityLog, [`Multi-task violation detected in iteration ${iteration}`]);

        // Append guardrail sign to plan
        const guardrailsTextNow = await readText(config.guardrailsFile);
        const guardrailsUpdated = appendSign(
          guardrailsTextNow,
          `Multi-task violation detected in iteration ${iteration}: Single-task mode enforced`
        );
        if (guardrailsUpdated !== guardrailsTextNow) {
          await writeText(config.guardrailsFile, guardrailsUpdated);
          bytesWritten += Buffer.byteLength(guardrailsUpdated);
        }
      }
    }

    const taskLine = getTaskLine(taskAfter || taskText, { phaseId: currentPhaseId });
    const taskContext = extractChangeType(taskLine);
    const effectiveTestCommand = currentPhaseId ? phaseTestCommand(parsedTaskAfter, currentPhaseId) : config.testCommand;
    if (status === "success" && effectiveTestCommand) {
      const testDecision = await shouldRunTestsForIteration(config, parsedTaskAfter, currentPhaseId, {
        ...taskContext,
        taskLine,
      }, effectiveTestCommand);
      if (testDecision.run) {
        printStep(`Tests run ${redact(effectiveTestCommand)}`, { iteration, kind: "tests" });
        const testResult = await runShellCommand(effectiveTestCommand, "", DEFAULTS.maxOutputBytes, {
          cwd: config.cwd,
          noColor: config.noColor,
          stopSignal,
        });
        if (testResult.aborted) {
          return await abortIteration("tests");
        }
        const testOutput = truncate(redact(`${testResult.stdout}\n${testResult.stderr}`), DEFAULTS.maxOutputBytes);
        await writeText(lastTestOutputPath, testOutput);
        bytesWritten += Buffer.byteLength(testOutput);
        const testOutcome = testResult.code === 0 ? "pass" : "fail";
        const testTimestamp = formatLocalTimestamp(new Date());
        testStatus = testTimestamp ? `${testOutcome} @ ${testTimestamp}` : `${testOutcome}`;
        if (testOutcome === "fail") {
          printStep(
            `Tests fail (see ${prettyPath(config.cwd, lastTestOutputPath)})`,
            { iteration, level: "error", kind: "tests" }
          );
        } else {
          printStep("Tests pass", { iteration, kind: "tests", level: "success" });
        }
        if (testOutcome === "fail") {
          status = "failure";
          lastError = testOutput.split(/\r?\n/).find(Boolean) || "test failure";
          errorSignature = `${effectiveTestCommand}::${lastError}`;
        }
      } else {
        testStatus = `skipped (${testDecision.reason})`;
        printStep(`Tests skipped: ${testDecision.reason}`, { iteration, kind: "tests", level: "warn" });
        await appendActivity(config.activityLog, [`tests skipped: ${testDecision.reason}`]);
      }
    }
    const taskComplete = Boolean(
      parsedTaskAfter.allChecked &&
      areAllPhasesComplete(parsedTaskAfter, state, { testStatus })
    );
    const completedSections = findNewlyCompletedTasks(parsedTask, parsedTaskAfter);
    printStepLines(formatCompletedTaskLines(completedSections), { iteration });
    printStepLines([formatProgressLine(summarizePlanProgress(parsedTaskAfter, currentPhaseId))], { iteration });
    const taskSummary = taskContext.summary;
    let changeType = taskContext.changeType;
    if (taskContext.changeType === "chore" && !/^[a-zA-Z]+\s*:/.test(taskLine || "")) {
      const heuristicType = inferChangeTypeHeuristic(taskLine);
      // Only invoke the (expensive) agent classifier when the heuristic
      // falls back to the generic "feat" default -- meaning it wasn't
      // confident.  When the heuristic matches a specific keyword the
      // result is already reliable, so we skip the extra agent call.
      if (config.gitCommit && heuristicType === "feat") {
        const agentType = await inferChangeTypeFromAgent(config.agentCommand, taskLine, {
          noColor: config.noColor,
        });
        changeType = agentType || heuristicType;
      } else {
        changeType = heuristicType;
      }
    }
    await appendActivity(config.activityLog, [`change_type inferred: ${changeType} (task: ${taskLine})`]);

    let postIterationRan = false;
    if (status === "success" && config.postIteration) {
      printStep(`Hook post-iteration run ${redact(config.postIteration)}`, { iteration, kind: "hook" });
      const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
        noColor: config.noColor,
        stopSignal,
      });
      if (hookResult.aborted) {
        return await abortIteration("post-iteration hook");
      }
      postIterationRan = true;
      await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
      printStep(`Hook post-iteration exit ${hookResult.code}`, { iteration, kind: "hook" });
    }

    if (status === "success") {
      try {
        if (config.gitCommit) {
          printStep("Git commit enabled; checking changes", { iteration, kind: "git" });
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
          printStep(`Git commit ${commitResult.hash || "(unknown hash)"}`, {
            iteration,
            kind: "git",
            level: "success",
          });
        } else if (config.gitCommit) {
          printStep(`Git commit skipped: ${commitResult.reason}`, { iteration, kind: "git" });
        }
      } catch (err) {
        status = "failure";
        lastError = err && err.message ? err.message : String(err);
        errorSignature = `git commit::${lastError}`;
        printStep(`Git commit failed: ${lastError}`, { iteration, level: "error", kind: "git" });
      }
    }

    if (status === "failure" && config.onFailure) {
      printStep(`Hook on-failure run ${redact(config.onFailure)}`, { iteration, kind: "hook" });
      const hookResult = await runShellCommand(config.onFailure, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
        noColor: config.noColor,
        stopSignal,
      });
      if (hookResult.aborted) {
        return await abortIteration("on-failure hook");
      }
      await appendActivity(config.activityLog, [`onFailure hook exit ${hookResult.code}`]);
      printStep(`Hook on-failure exit ${hookResult.code}`, { iteration, kind: "hook" });
    }

    if (!postIterationRan && config.postIteration) {
      printStep(`Hook post-iteration run ${redact(config.postIteration)}`, { iteration, kind: "hook" });
      const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
        cwd: config.cwd,
        noColor: config.noColor,
        stopSignal,
      });
      if (hookResult.aborted) {
        return await abortIteration("post-iteration hook");
      }
      await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
      printStep(`Hook post-iteration exit ${hookResult.code}`, { iteration, kind: "hook" });
    }

    const modifiedFiles = await getGitModifiedFiles(config.cwd);
    const iterationEndedAt = new Date();
    const iterationDurationMs = iterationEndedAt.getTime() - iterationStartedAt.getTime();

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
      iterationDurations: [...(state.iterationDurations || []), iterationDurationMs],
    };

    const historyEntry = `${nextState.updatedAt} iteration ${iteration} ${status} (test: ${testStatus})`;
    nextState.history = [...nextState.history, historyEntry].slice(-50);

    // Phase completion / progression.
    if (status === "success" && currentPhaseId && parsedTaskAfter.phases && parsedTaskAfter.phases.length) {
      const phaseComplete = isPhaseComplete(parsedTaskAfter, currentPhaseId, nextState, { testStatus });
      if (phaseComplete) {
        const nextPhase = computeNextPhaseId(parsedTaskAfter, currentPhaseId, config);
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

    if (!config.phaseOnly && parsedTaskAfter.phases && parsedTaskAfter.phases.length) {
      const syncedPhase = pickCurrentPhaseId(parsedTaskAfter, nextState, config, {
        phaseExplicit: Boolean(config.phaseExplicit),
      });
      if (syncedPhase && syncedPhase !== nextState.currentPhase) {
        nextState.currentPhase = syncedPhase;
      }
    }

    if (status === "failure") {
      const repeat = detectRepeatFailure(nextState, errorSignature, config.guardrailRepeatLimit);
      nextState = repeat.state;

      const thrashCheck = detectThrash(nextState, modifiedFiles);
      nextState = thrashCheck.state;

      let guardrailsUpdated = guardrailsText;

      if (repeat.repeated) {
        guardrailsUpdated = appendSign(
          guardrailsUpdated,
          `Repeated failure signature (>= ${config.guardrailRepeatLimit}): ${errorSignature}`
        );
        guardrailCooldownMs = Math.max(guardrailCooldownMs, config.guardrailCooldownMs);
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
        `Guardrail stop (${guardrailStopReason}) (see ${prettyPath(config.cwd, config.guardrailsFile)})`,
        { iteration, level: "warn", kind: "guardrail" }
      );
    } else if (guardrailCooldownMs > 0) {
      nextState.lastStatus = status;
      printStep(
        `Guardrail cooldown (repeated failure signature). Backing off ${guardrailCooldownMs}ms`,
        { iteration, level: "warn", kind: "guardrail" }
      );
      await appendActivity(config.activityLog, [
        `Guardrail cooldown triggered: repeated failure signature (>= ${config.guardrailRepeatLimit}).`,
      ]);
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
      `State updated ${prettyPath(config.cwd, config.stateFile)} (status: ${nextState.lastStatus}, test: ${nextState.lastTest})`,
      { iteration, kind: "state" }
    );

    await appendActivity(config.activityLog, [
      `Iteration ${iteration} ${status}`,
      `Bytes read/written: ${bytesRead}/${bytesWritten}`,
    ]);

    if (taskComplete) {
      await appendActivity(config.activityLog, ["Plan complete detected after iteration."]);
      printStep(`Plan complete after iteration`, { iteration, kind: "plan" });
      iterationStatus = status;
      return { status: "complete", bytes: bytesRead + bytesWritten };
    }

    if (nextState.lastStatus === "phase-complete") {
      await appendActivity(config.activityLog, [`Phase complete (${currentPhaseId}); --phase-only stopping.`]);
      printStep(`Phase ${currentPhaseId} complete; --phase-only stopping`, { iteration, kind: "plan" });
      iterationStatus = status;
      return { status: "complete", bytes: bytesRead + bytesWritten };
    }

    iterationStatus = status;
    printStep(`Status ${status} (tests: ${testStatus})`, {
      iteration,
      kind: "result",
      level: status === "failure" ? "error" : undefined,
    });
    return { status, bytes: bytesRead + bytesWritten, guardrailStopReason, guardrailCooldownMs };
  } finally {
    endIteration({ iteration, status: iterationStatus });
  }
}

module.exports = {
  runIteration,
};
