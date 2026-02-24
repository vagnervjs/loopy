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
  resolvePrdRefsForCurrentTask,
} = require("../task");
const { formatLocalTimestamp, redact, truncate } = require("../text");
const {
  gitCommitIfNeeded,
  diffGitWorktreeSnapshots,
  getGitModifiedFiles,
  getGitWorktreeSnapshot,
} = require("../git");
const { areAllPhasesComplete, pickCurrentPhaseId, resolvePhaseLabel, phaseNeedsValidation, isPhaseAllChecked, isPhaseComplete, computeNextPhaseId } = require("./phases");
const {
  findNewlyCompletedTasks,
  formatCompletedTaskLines,
  formatProgressLine,
  printStepLines,
  summarizePlanProgress,
} = require("./plan-overview");
function parseLoopyTestReport(text) {
  const raw = String(text || "");
  const match = raw.match(/```loopy_test_report\s*([\s\S]*?)```/i);
  if (!match) return { ok: false, reason: "missing_test_report" };
  const payload = String(match[1] || "").trim();
  if (!payload) return { ok: false, reason: "invalid_test_report", detail: "empty payload" };
  let parsed = null;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return { ok: false, reason: "invalid_test_report", detail: err && err.message ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "invalid_test_report", detail: "payload is not an object" };
  }
  const status = String(parsed.status || "").trim().toLowerCase();
  const command = String(parsed.command || "").trim();
  const summary = String(parsed.summary || "").trim();
  const evidence = String(parsed.evidence || "").trim();
  const missing = [];
  if (!["pass", "fail", "skipped"].includes(status)) missing.push("status (must be pass|fail|skipped)");
  if (!command) missing.push("command (string: the test command that was run)");
  if (!summary) missing.push("summary (string: one-line result description)");
  if (!evidence) missing.push("evidence (string: relevant output excerpt)");
  if (missing.length) {
    const got = Object.keys(parsed).join(", ");
    return { ok: false, reason: "invalid_test_report", detail: `missing required fields: ${missing.join("; ")}. Got keys: ${got}` };
  }
  return { ok: true, report: { status, command, summary, evidence } };
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

    const currentTaskObj = getCurrentTask(taskText, { phaseId: currentPhaseId });
    const currentTaskText = currentTaskObj ? currentTaskObj.text.trim() : null;
    const filteredPlan = currentPhaseId ? getCurrentPhaseSection(taskText, currentPhaseId) : taskText;
    const prdRefs = resolvePrdRefsForCurrentTask(parsedTask, currentPhaseId, currentTaskObj);

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
      prdRefs,
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

    // Snapshot dirty worktree state after pre-iteration hooks so thrash detection
    // can focus on files that actually changed during this iteration.
    const preIterationSnapshot = await getGitWorktreeSnapshot(config.cwd);

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
    const reportParse = parseLoopyTestReport(combinedOutput);
    const phaseValidationRequired = Boolean(
      currentPhaseId &&
      parsedTaskAfter.phases &&
      parsedTaskAfter.phases.length &&
      isPhaseAllChecked(parsedTaskAfter, currentPhaseId) &&
      phaseNeedsValidation(parsedTaskAfter, currentPhaseId)
    );
    if (reportParse.ok) {
      const report = reportParse.report;
      const testTimestamp = formatLocalTimestamp(new Date());
      testStatus = testTimestamp ? `${report.status} @ ${testTimestamp}` : report.status;
      const reportPayload = truncate(
        redact(
          JSON.stringify(
            {
              status: report.status,
              command: report.command,
              summary: report.summary,
              evidence: report.evidence,
            },
            null,
            2
          )
        ),
        DEFAULTS.maxOutputBytes
      );
      await writeText(
        lastTestOutputPath,
        reportPayload
      );
      bytesWritten += Buffer.byteLength(reportPayload);
      await appendActivity(config.activityLog, [`test-report parsed: ${report.status}`]);
      if (report.status === "fail" && status === "success") {
        status = "failure";
        lastError = report.summary || "test failure";
        errorSignature = `test-report::${lastError}`;
      }
    } else if (phaseValidationRequired && status === "success") {
      status = "failure";
      testStatus = `fail (${reportParse.reason})`;
      lastError = `${reportParse.reason}${reportParse.detail ? `: ${reportParse.detail}` : ""}`;
      errorSignature = `test-report::${reportParse.reason}`;
      await appendActivity(config.activityLog, [`test-report error: ${lastError}`]);
      printStep(`Test report invalid: ${lastError}`, { iteration, level: "error", kind: "tests" });
    } else {
      testStatus = "n/a";
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

    // Capture iteration-local file deltas before git commit so thrash detection
    // is based on files touched this iteration, not the entire dirty worktree.
    const postIterationSnapshot = await getGitWorktreeSnapshot(config.cwd);
    let modifiedFiles = diffGitWorktreeSnapshots(preIterationSnapshot, postIterationSnapshot);
    if (!modifiedFiles.length) {
      modifiedFiles = await getGitModifiedFiles(config.cwd);
    }

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

    let committedFiles = [];
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
          committedFiles = commitResult.filesChanged || [];
          await appendActivity(config.activityLog, [
            `git commit: ${commitResult.hash || "(unknown hash)"} ${commitResult.message}`,
            ...(committedFiles.length ? [`files committed: ${committedFiles.join(", ")}`] : []),
          ]);
          printStep(`Git commit ${commitResult.hash || "(unknown hash)"}`, {
            iteration,
            kind: "git",
            level: "success",
          });
        } else if (config.gitCommit) {
          if (commitResult.warning) {
            printStep(`commit skipped: ${commitResult.warning}`, { iteration, kind: "git", level: "warn" });
            await appendActivity(config.activityLog, [
              `commit skipped: ${commitResult.warning}`,
              ...(commitResult.filesChanged ? [`unrelated files: ${commitResult.filesChanged.join(", ")}`] : []),
            ]);
          } else {
            printStep(`Git commit skipped: ${commitResult.reason}`, { iteration, kind: "git" });
          }
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

    const iterationEndedAt = new Date();
    const iterationDurationMs = iterationEndedAt.getTime() - iterationStartedAt.getTime();

    let nextState = {
      ...state,
      iteration,
      lastStatus: taskComplete ? "complete" : status,
      lastTest: testStatus,
      lastContractError: reportParse.ok ? "" : reportParse.reason,
      lastPrdRefs: prdRefs,
      lastTestReport: reportParse.ok ? reportParse.report : null,
      lastTestReportStatus: reportParse.ok ? reportParse.report.status : "",
      lastTestReportCommand: reportParse.ok ? reportParse.report.command : "",
      lastTestReportEvidence: reportParse.ok ? reportParse.report.evidence : "",
      lastError: lastError || (status === "failure" ? state.lastError : "") || "",
      lastBytes: bytesRead + bytesWritten,
      rotatePending: false,
      updatedAt: new Date().toISOString(),
      startedAt: state.startedAt || new Date().toISOString(),
      history: state.history || [],
      currentPhase: currentPhaseId || state.currentPhase || "",
      phaseHistory: state.phaseHistory || [],
      iterationDurations: [...(state.iterationDurations || []), iterationDurationMs],
    };

    const filesChangedSuffix = committedFiles.length ? ` [files: ${committedFiles.join(", ")}]` : "";
    const historyEntry = `${nextState.updatedAt} iteration ${iteration} ${status} (test: ${testStatus})${filesChangedSuffix}`;
    nextState.history = [...nextState.history, historyEntry].slice(-50);

    // Phase completion / progression (two-gate model).
    if (status === "success" && currentPhaseId && parsedTaskAfter.phases && parsedTaskAfter.phases.length) {
      const phaseComplete = isPhaseComplete(parsedTaskAfter, currentPhaseId, nextState, { testStatus });
      if (phaseComplete) {
        const nextPhase = computeNextPhaseId(parsedTaskAfter, currentPhaseId, config);
        nextState.phaseHistory = [...(nextState.phaseHistory || [])].concat([
          `${nextState.updatedAt} phase ${currentPhaseId} complete`,
        ]).slice(-100);
        printStep(`Phase ${currentPhaseId} complete (all tasks checked, tests pass)`, {
          iteration,
          kind: "plan",
          level: "success",
        });
        await appendActivity(config.activityLog, [`phase ${currentPhaseId} complete`]);
        if (config.phaseOnly) {
          nextState.lastStatus = "phase-complete";
        } else if (nextPhase) {
          nextState.currentPhase = nextPhase;
          nextState.phaseHistory = [...(nextState.phaseHistory || [])].concat([
            `${nextState.updatedAt} phase advanced: ${currentPhaseId} -> ${nextPhase}`,
          ]).slice(-100);
        }
      } else {
        // Check if all tasks are checked but tests are failing (Gate 1 passed, Gate 2 failed)
        const allTasksChecked = isPhaseAllChecked(parsedTaskAfter, currentPhaseId);
        if (allTasksChecked && status === "success" && /^fail\b/i.test(testStatus)) {
          printStep(
            `Phase ${currentPhaseId} tasks complete but tests failing — fixing`,
            { iteration, kind: "plan", level: "warn" }
          );
          await appendActivity(config.activityLog, [
            `phase ${currentPhaseId} tasks complete but tests failing`,
          ]);
        }
      }
    }

    if (status === "failure") {
      const repeat = detectRepeatFailure(nextState, errorSignature, config.guardrailRepeatLimit);
      nextState = repeat.state;

      const thrashCheck = detectThrash(nextState, modifiedFiles, state);
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
        const thrashFiles = thrashCheck.files.join(", ");
        const thrashLevel = thrashCheck.level;

        if (thrashLevel >= 3) {
          // Third+ trigger: auto-block the current task and skip
          guardrailsUpdated = appendSign(
            guardrailsUpdated,
            `File thrashing escalation (level ${thrashLevel}): ${thrashFiles} — task auto-blocked, skipping to next task`
          );
          guardrailStopReasons.push(`File thrashing escalated to level ${thrashLevel} on ${thrashFiles}. Task auto-blocked.`);
          nextState.thrashBlockedTasks = [...(nextState.thrashBlockedTasks || []), {
            task: taskSummary || taskLine || "",
            files: thrashCheck.files,
            iteration,
            reason: `file thrashing escalation (level ${thrashLevel})`,
          }];
          printStep(
            `Thrash escalation level ${thrashLevel}: auto-blocking task and skipping to next`,
            { iteration, level: "error", kind: "guardrail" }
          );
          await appendActivity(config.activityLog, [
            `thrash escalation level ${thrashLevel} on ${thrashFiles}: task auto-blocked`,
          ]);
        } else if (thrashLevel === 2) {
          // Second trigger: force re-scope via guardrails text
          guardrailsUpdated = appendSign(
            guardrailsUpdated,
            `File thrashing (2nd trigger) on ${thrashFiles}. ` +
            `This task has thrashed on ${thrashFiles} twice. Re-evaluate your approach. ` +
            `If the task is blocked by external factors, mark it as blocked.`
          );
          guardrailStopReasons.push("File thrashing detected (2nd trigger). Re-scope required.");
          printStep(
            `Thrash escalation level 2: forcing re-scope on ${thrashFiles}`,
            { iteration, level: "warn", kind: "guardrail" }
          );
          await appendActivity(config.activityLog, [
            `thrash escalation level 2 on ${thrashFiles}: re-scope required`,
          ]);
        } else {
          // First trigger: pause (original behavior)
          guardrailsUpdated = appendSign(guardrailsUpdated, `File thrashing detected: ${thrashFiles}`);
          guardrailStopReasons.push("File thrashing detected (>= 3).");
        }
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
