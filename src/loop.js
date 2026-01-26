const fs = require("fs/promises");
const path = require("path");

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
const { runShellCommand } = require("./shell");
const { loadState } = require("./state");
const { printStep } = require("./steps");
const { getTaskLine, parseTask } = require("./task");
const { redact, truncate } = require("./text");
const {
  ensureGitRepo,
  ensureGitWorktree,
  getGitModifiedFiles,
  gitCommitIfNeeded,
  gitSwitchBranch,
} = require("./git");

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

  printStep(`Iteration start (rotation: ${rotationPending ? "fresh" : "standard"})`, { iteration });

  const lastOutputRaw = rotationPending ? "" : await readText(path.join(config.ralphDir, "last_agent_output.txt"));
  bytesRead += Buffer.byteLength(lastOutputRaw);
  const lastOutput = truncate(lastOutputRaw, 4000);

  const prompt = formatPrompt({
    iteration,
    taskText,
    guardrailsText,
    progressText: progressText || "(no progress recorded yet)",
    lastOutput,
    rotationPending,
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
    throw new Error("Missing agent_command. Set it in LOOPY_TASK.md front matter or use --agent-cmd.");
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
    : path.join(config.ralphDir, "agent_stream.log");

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

  await writeText(path.join(config.ralphDir, "last_agent_output.txt"), combinedOutput);
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
  if (status === "success" && config.testCommand) {
    printStep(`Running tests: ${redact(config.testCommand)}`, { iteration });
    const testResult = await runShellCommand(config.testCommand, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    const testOutput = truncate(redact(`${testResult.stdout}\n${testResult.stderr}`), DEFAULTS.maxOutputBytes);
    await writeText(path.join(config.ralphDir, "last_test_output.txt"), testOutput);
    bytesWritten += Buffer.byteLength(testOutput);
    const testOutcome = testResult.code === 0 ? "pass" : "fail";
    testStatus = `${testOutcome} @ ${new Date().toISOString()}`;
    printStep(`Test result: ${testOutcome}`, { iteration });
    if (testOutcome === "fail") {
      status = "failure";
      lastError = testOutput.split(/\r?\n/).find(Boolean) || "test failure";
      errorSignature = `${config.testCommand}::${lastError}`;
    }
  }

  const taskAfter = await readText(config.taskFile);
  bytesRead += Buffer.byteLength(taskAfter);
  const taskComplete = taskAfter ? parseTask(taskAfter).allChecked : false;
  const taskLine = getTaskLine(taskAfter || taskText);
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
  };

  const historyEntry = `${nextState.updatedAt} iteration ${iteration} ${status} (test: ${testStatus})`;
  nextState.history = [...nextState.history, historyEntry].slice(-50);

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

  printStep(`Iteration result: ${status} (test: ${testStatus})`, { iteration });
  return { status, bytes: bytesRead + bytesWritten, guardrailStopReason };
}

async function runLoop(command, flags, { stopSignal, onActivityLog } = {}) {
  const stop = stopSignal || { stopRequested: false };
  const baseCwd = process.cwd();
  const initialTaskPath = resolveFrom(baseCwd, flags.task || DEFAULTS.taskFile);
  const taskText = await readText(initialTaskPath);
  const parsedTask = taskText ? parseTask(taskText) : { frontMatter: {} };
  let config = mergeConfig(flags, parsedTask.frontMatter);

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

