const fs = require("fs/promises");
const path = require("path");
const yaml = require("js-yaml");

const { appendActivity } = require("./activity");
const {
  DEFAULTS,
  formatDuration,
  materializeConfigPaths,
  loadGlobalConfig,
  persistGlobalAgentCommand,
  mergeConfig,
  prettyPath,
  resolveFrom,
} = require("./config");
const { confirm, promptLine, promptSelect } = require("./confirm");
const { readText, writeText } = require("./fs");
const { ensureGitRepo, getCurrentBranch, ensureGitWorktree, gitSwitchBranch } = require("./git");
const { generatePrdWithAgent } = require("./prd");
const { formatProgress } = require("./prompt");
const { loadState } = require("./state");
const { configureSteps, formatDurationMs, printBlankLine, printStep } = require("./steps");
const { parseTask } = require("./task");
const { redact } = require("./text");
const { buildAgentChoiceOptions, detectAvailableAgents } = require("./agent");
const { validateConfig } = require("./config-validate");
const { archiveCompletedLoop } = require("./loop/archive");
const { runIteration } = require("./loop/iteration");
const { formatPlanOverviewLines, printStepLines } = require("./loop/plan-overview");
const { loadPromptTemplate } = require("./loop/prompt-templates");
const { confirmPlanReview, ensureTaskBeforeLoop, writePromptPreview } = require("./loop/plan-ensure");
const { loadPlanSeed, loadTaskSeed, readStdinText } = require("./loop/seed");

async function runLoop(command, flags, { stopSignal, onActivityLog } = {}) {
  const stop = stopSignal || { stopRequested: false };
  const baseCwd = process.cwd();
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const planSeedProvided = hasOwn(flags, "plan");
  const promptSeedProvided = hasOwn(flags, "prompt");
  const phaseExplicit = hasOwn(flags, "phase") && flags.phase !== true;
  if (command === "run") {
    throw new Error("Unsupported command. For a single iteration, use `loopy --max-iterations 1`.");
  }

  const { config: globalDefaults } = await loadGlobalConfig();
  const preConfig = mergeConfig(flags, {}, globalDefaults);
  const defaultPlanPath = resolveFrom(baseCwd, preConfig.taskFile || DEFAULTS.taskFile);
  const planText = await readText(defaultPlanPath);

  const parsedTask = planText ? parseTask(planText) : { frontMatter: {} };
  let config = mergeConfig(flags, parsedTask.frontMatter, globalDefaults);
  validateConfig({
    flags,
    config,
    planSeedProvided,
    promptSeedProvided,
    defaultMode: DEFAULTS.mode,
  });
  configureSteps({ noColor: config.noColor, noEmoji: config.noEmoji, plain: config.plain });

  const fm0 = (parsedTask && parsedTask.frontMatter) || {};
  const fmGit = fm0.git && typeof fm0.git === "object" ? fm0.git : {};
  const agentCommandExplicit =
    hasOwn(flags, "agent") ||
    Object.prototype.hasOwnProperty.call(fm0, "agent_command") ||
    Object.prototype.hasOwnProperty.call(fm0, "agentCommand");
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
  if (!agentCommandExplicit) {
    const initialAgentCommand = config.agentCommand;
    if (process.stdin.isTTY) {
      const availableAgents = await detectAvailableAgents();
      const { options, defaultValue } = buildAgentChoiceOptions(availableAgents, initialAgentCommand, {
        includeCustom: true,
      });
      let selected = "";
      if (options.length) {
        selected = await promptSelect("Select agent command:", options, { defaultValue });
        if (selected === "__custom__") {
          selected = await promptLine('Enter agent command (e.g. "cursor-agent"):', {
            defaultValue: initialAgentCommand,
          });
        }
      } else {
        selected = await promptLine('Enter agent command (e.g. "cursor-agent"):', {
          defaultValue: initialAgentCommand,
        });
      }
      if (selected) {
        config.agentCommand = selected;
      }
      if (selected && selected !== initialAgentCommand) {
        try {
          await persistGlobalAgentCommand(selected);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          printStep(`Global config update failed: ${message}`, { level: "warn" });
        }
      }
    }
  }
  if (!config.agentCommand) {
    throw new Error(
      `Missing agent_command. Set it in ${prettyPath(baseCwd, resolveFrom(baseCwd, config.taskFile))} front matter or use --agent.`
    );
  }

  // Default git branch when missing (only when running inside a git repo).
  if (!config.resume && config.mode !== "plan") {
    const hasGitBranch = Boolean(String(config.gitBranch || "").trim());
    const hasWorktreeBranch = Boolean(String(config.gitWorktreeBranch || "").trim());
    if (!hasGitBranch && !hasWorktreeBranch) {
      if (isGitRepo) {
        if (!process.stdin.isTTY) {
          throw new Error(
            "Missing git branch name. Provide --git-branch <name> or set git.branch in the plan front matter."
          );
        }
        const currentBranch = await getCurrentBranch(baseCwd);
        const defaultBranch = currentBranch || "";
        const promptMsg = currentBranch
          ? `Enter git branch name (default: ${currentBranch}):`
          : 'Enter git branch name (e.g. "loopy/my-task"):';
        const entered = await promptLine(promptMsg, { defaultValue: defaultBranch });
        if (!entered) {
          throw new Error("Aborted: git branch name is required.");
        }
        config.gitBranch = String(entered || "").trim();
      }
    }
  }

  printStep(
    `Loop start (max iterations: ${config.maxIterations}, max minutes: ${config.maxMinutes}, backoff: ${config.backoffMs}ms)`,
    { kind: "loop-start" }
  );

  // Optional git workspace setup (worktree / branch). This is done once, before the loop.
  let effectiveCwd = baseCwd;
  if (config.gitWorktree && config.mode !== "plan") {
    const worktreeAbs = resolveFrom(baseCwd, config.gitWorktree);
    if (config.resume) {
      // Resume mode: use existing worktree path only (don't create/switch).
      try {
        const stat = await fs.stat(worktreeAbs);
        if (!stat.isDirectory()) {
          throw new Error(`Worktree path exists but is not a directory: ${worktreeAbs}`);
        }
      } catch (err) {
        if (err && err.code === "ENOENT") {
          throw new Error(
            `Cannot resume: git worktree path not found: ${prettyPath(baseCwd, worktreeAbs)} (run without --resume to create it)`
          );
        }
        throw err;
      }
      effectiveCwd = worktreeAbs;
      await ensureGitRepo(effectiveCwd);
      printStep(`Git worktree using existing ${prettyPath(baseCwd, effectiveCwd)} (--resume)`, { kind: "git" });
    } else {
      printStep(
        `Git worktree ensure ${prettyPath(baseCwd, worktreeAbs)}` +
          (config.gitWorktreeBranch ? ` (branch: ${config.gitWorktreeBranch})` : " (detached)"),
        { kind: "git" }
      );
      effectiveCwd = await ensureGitWorktree(baseCwd, config.gitWorktree, config.gitWorktreeBranch);
      printStep(`Git worktree using ${prettyPath(baseCwd, effectiveCwd)}`, { kind: "git" });
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
  if (config.gitBranch && config.mode !== "plan") {
    if (config.resume) {
      printStep(`Branch ${config.gitBranch} (--resume)`, { kind: "branch" });
    } else {
      printStep(`Git branch switch to ${config.gitBranch}`, { kind: "git" });
      await ensureGitRepo(effectiveCwd);
      await gitSwitchBranch(effectiveCwd, config.gitBranch);
      printStep(`Branch ${config.gitBranch}`, { kind: "branch" });
    }
  }
  if (!config.gitBranch && config.gitWorktreeBranch && config.mode !== "plan") {
    printStep(`Branch ${config.gitWorktreeBranch}`, { kind: "branch" });
  }

  config = materializeConfigPaths(config, effectiveCwd);
  config.phaseExplicit = phaseExplicit;
  if (onActivityLog) onActivityLog(config.activityLog);
  const promptTemplate = await loadPromptTemplate(config);
  config.promptTemplateText = promptTemplate.text;
  config.promptTemplatePath = promptTemplate.path;
  let prdGenerated = false;
  const planReviewRequired = !config.resume && (planSeedProvided || promptSeedProvided);
  const stopBeforeLoop = async (message) => {
    const note = message || "Stop requested; exiting before loop";
    printStep(note, { kind: "result", level: "warn" });
    try {
      await appendActivity(config.activityLog, [note]);
    } catch (_) {
      // ignore
    }
  };

  if (config.resume) {
    // Resume mode: require existing plan + state, but do not create/update the plan doc.
    const taskTextNow = await readText(config.taskFile);
    if (!taskTextNow) {
      throw new Error(
        `Cannot resume: missing ${prettyPath(config.cwd, config.taskFile)}. Run \`loopy init\` or run without --resume and provide --prompt.`
      );
    }

    let stateText = "";
    try {
      stateText = await fs.readFile(config.stateFile, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new Error(
          `No Loopy state found at ${prettyPath(config.cwd, config.stateFile)}.\nRun \`loopy\` first (without --resume).`
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
    printStep(`Resume iteration ${iter}${phase}; last status: ${last}`, { kind: "resume" });
    config.taskSeedText = "";
    config.taskSeedSource = "";
  } else {
    const planSeedRaw = String(config.planSeed || "").trim();
    const promptSeedRaw = String(config.promptSeed || "").trim();
    const usesPlanStdin = planSeedRaw === "-";
    const usesPromptStdin = promptSeedRaw === "-";
    if (usesPlanStdin && usesPromptStdin) {
      throw new Error("Cannot read stdin for both --plan and --prompt.");
    }
    const stdinText = usesPlanStdin || usesPromptStdin ? await readStdinText() : undefined;

    const loadedPlanSeed = await loadPlanSeed(config, { stdinText });
    const loadedPromptSeed = await loadTaskSeed(config, { stdinText });
    let effectiveSeed = loadedPromptSeed;

    if (loadedPlanSeed.seed) {
      const agentLabel = config.agentCommand ? ` with ${redact(config.agentCommand)}` : "";
      printStep(`Generating PRD${agentLabel}`, { kind: "plan" });
      const prdResult = await generatePrdWithAgent(config.agentCommand, loadedPlanSeed.seed, {
        extraContext: loadedPromptSeed.seed || "",
        cwd: config.cwd,
        noColor: config.noColor,
        stopSignal: stop,
      });
      if (prdResult.aborted || stop.stopRequested) {
        await stopBeforeLoop("PRD generation aborted; exiting before loop");
        return;
      }
      const prdText = prdResult.text;
      const payload = `${prdText.trimEnd()}\n`;
      await writeText(config.prdFile, payload);
      prdGenerated = true;

      const seedSources = [];
      if (loadedPlanSeed.seed) seedSources.push(loadedPlanSeed.source);
      if (loadedPromptSeed.seed) seedSources.push(loadedPromptSeed.source);
      const combinedSource = seedSources.join(" + ");
      config.taskSeedText = prdText;
      config.taskSeedSource = combinedSource || loadedPlanSeed.source || "--plan";
      effectiveSeed = { seed: prdText, source: config.taskSeedSource };

      await appendActivity(config.activityLog, [
        `PRD generated: ${prettyPath(config.cwd, config.prdFile)}`,
      ]);
      printStep(`PRD generated: ${prettyPath(config.cwd, config.prdFile)}`, { kind: "plan" });
    } else {
      config.taskSeedText = loadedPromptSeed.seed || "";
      config.taskSeedSource = loadedPromptSeed.source || "";
    }

    // Plan initialization / auto-phase planning happens once, before looping.
    if (planReviewRequired) {
      printStep("Preparing plan doc from seed", { kind: "plan" });
    }
    const ensured = await ensureTaskBeforeLoop(config, effectiveSeed, { stopSignal: stop });
    if (ensured.aborted || stop.stopRequested) {
      await stopBeforeLoop("Stop requested; exiting before loop");
      return;
    }
    if (ensured.rewritten) {
      await appendActivity(config.activityLog, [
        `Plan updated before loop: ${prettyPath(config.cwd, config.taskFile)}`,
      ]);
      printStep(`Plan updated before loop: ${prettyPath(config.cwd, config.taskFile)}`, { kind: "plan" });
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

  const summaryText = await readText(config.taskFile);
  const parsedSummary = summaryText ? parseTask(summaryText) : null;
  const planLines = formatPlanOverviewLines(parsedSummary, { verbose: config.verbose });
  if (planLines.length) {
    printBlankLine();
    printStepLines(planLines, {});
  }
  if (planReviewRequired) {
    await confirmPlanReview(config, { prdGenerated });
  }

  if (config.mode === "plan") {
    await writePromptPreview(config);
    await appendActivity(config.activityLog, ["Plan-only mode: skipping build iterations."]);
    printStep("Plan-only mode: skipping build iterations", { kind: "plan" });
    return;
  }

  const start = Date.now();
  let iteration = 0;

  while (!stop.stopRequested) {
    const elapsedMinutes = (Date.now() - start) / 60000;
    if (iteration >= config.maxIterations) {
      await appendActivity(config.activityLog, ["Max iterations reached. Stopping."]);
      printStep("Max iterations reached; stopping", { kind: "result", level: "warn" });
      break;
    }
    if (elapsedMinutes >= config.maxMinutes) {
      await appendActivity(config.activityLog, [
        `Max wall time reached (${formatDuration(config.maxMinutes)}). Stopping.`,
      ]);
      printStep(`Max wall time reached (${formatDuration(config.maxMinutes)}); stopping`, {
        kind: "result",
        level: "warn",
      });
      break;
    }

    const result = await runIteration(config, { stopSignal: stop });
    iteration += 1;

    if (result.status === "complete") {
      break;
    }

    // `--dry-run` builds the prompt and skips agent execution. Since dry runs don't
    // advance state iterations, stop after the first iteration to avoid looping
    // forever (and to keep CLI/test behavior fast and predictable).
    if (config.dryRun) {
      await appendActivity(config.activityLog, ["Dry run complete. Stopping."]);
      printStep("Dry run complete; stopping", { kind: "result", level: "warn" });
      break;
    }

    if (result.guardrailStopReason) {
      await appendActivity(config.activityLog, [`Guardrail stop triggered: ${result.guardrailStopReason}`]);
      break;
    }

    if (stop.stopRequested) {
      await appendActivity(config.activityLog, ["Stop requested. Exiting loop."]);
      printStep("Stop requested; exiting", { kind: "result", level: "warn" });
      break;
    }

    const sleepMs =
      result.guardrailCooldownMs && result.guardrailCooldownMs > 0 ? result.guardrailCooldownMs : config.backoffMs;
    if (sleepMs > 0) {
      printStep(`Sleeping ${sleepMs}ms before next iteration`, { kind: "sleep" });
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
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
    printStep("Loop stopped", { kind: "loop-stop", level: "warn" });
  }

  // Load state before archiving (archiving moves the state file)
  const finalState = await loadState(config.stateFile);
  const totalDurationMs = (finalState.state.iterationDurations || []).reduce((sum, d) => sum + d, 0);

  const archiveResult = await archiveCompletedLoop(config);
  if (archiveResult.archived) {
    const prettyArchive = prettyPath(config.cwd, archiveResult.archiveDir);
    printStep(`Archive ${prettyArchive}`, { kind: "archive" });
  }

  // Log celebration and total duration after archival
  printStep(`All tasks complete! 🎉`, { kind: "plan" });
  if (totalDurationMs > 0) {
    printStep(`Total duration 🕐 ${formatDurationMs(totalDurationMs)}`, { kind: "plan" });
  }
}

module.exports = {
  runLoop,
};
