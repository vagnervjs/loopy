const path = require("path");

const DEFAULTS = {
  taskFile: ".loopy/LOOPY_PLAN.md",
  promptFile: ".loopy/PROMPT.md",
  loopyDir: ".loopy",
  progressFile: ".loopy/progress.md",
  guardrailsFile: ".loopy/guardrails.md",
  activityLog: ".loopy/activity.log",
  agentStreamLog: ".loopy/agent_stream.log",
  stateFile: ".loopy/state.json",
  hintsFile: ".loopy/hints.md",
  maxIterations: 50,
  maxMinutes: 120,
  backoffMs: 5000,
  rotateBytes: 150000,
  maxOutputBytes: 1024 * 1024,
  gitCommit: true,
  gitCommitMessage: "loopy: {change_type} {task_summary}",
  autoPhase: true,
  confirm: false,
};

function resolveFrom(cwd, maybePath) {
  if (!maybePath) return maybePath;
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.resolve(cwd || process.cwd(), maybePath);
}

function prettyPath(cwd, filePath) {
  if (!filePath) return "";
  const base = cwd || process.cwd();
  const rel = path.relative(base, filePath);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : filePath;
}

function materializeConfigPaths(config, cwd) {
  const nextCwd = cwd || config.cwd || process.cwd();
  return {
    ...config,
    cwd: nextCwd,
    taskFile: resolveFrom(nextCwd, config.taskFile),
    promptFile: resolveFrom(nextCwd, config.promptFile),
    loopyDir: resolveFrom(nextCwd, config.loopyDir || DEFAULTS.loopyDir),
    progressFile: resolveFrom(nextCwd, config.progressFile),
    guardrailsFile: resolveFrom(nextCwd, config.guardrailsFile),
    activityLog: resolveFrom(nextCwd, config.activityLog),
    stateFile: resolveFrom(nextCwd, config.stateFile),
    hintsFile: resolveFrom(nextCwd, config.hintsFile || DEFAULTS.hintsFile),
  };
}

function normalizeCommand(command) {
  if (!command || typeof command !== "string") return "";
  return command.trim();
}

function coerceNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function coerceBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function resolveNoColor(flags) {
  const hasFlag = Object.prototype.hasOwnProperty.call(flags || {}, "no-color");
  if (hasFlag) {
    return coerceBoolean(flags["no-color"], true);
  }
  return Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
}

function clampMin(value, minValue) {
  if (!Number.isFinite(value)) return minValue;
  return value < minValue ? minValue : value;
}

function formatDuration(minutes) {
  return `${minutes}m`;
}

function mergeConfig(flags, frontMatter) {
  const fm = frontMatter || {};
  const hooks = fm.hooks || {};
  const git = fm.git || {};
  const phaseDefaults = fm.phase_defaults || fm.phaseDefaults || {};
  const hasPromptSeed = Object.prototype.hasOwnProperty.call(flags, "prompt");
  const promptSeedFlag = hasPromptSeed ? flags.prompt : undefined;
  const promptOutFlag = flags["prompt-out"];
  const gitWorktreeFlag = flags["git-worktree"];
  const gitWorktreeBranchFlag = flags["git-worktree-branch"];
  const plain = coerceBoolean(flags.plain, false);
  const noEmoji = coerceBoolean(flags["no-emoji"], false);
  return {
    cwd: process.cwd(),
    continue: coerceBoolean(flags.continue, false),
    confirm: coerceBoolean(flags.confirm, DEFAULTS.confirm),
    // NOTE: `--plan` is the plan doc path. (Internally we still call it `taskFile`.)
    taskFile: flags.plan || DEFAULTS.taskFile,
    // NOTE: `--prompt` is reserved for the seed prompt. Use `--prompt-out` for the generated prompt markdown file.
    promptFile: (promptOutFlag === true ? "" : String(promptOutFlag || "")) || DEFAULTS.promptFile,
    loopyDir: DEFAULTS.loopyDir,
    progressFile: flags.progress || DEFAULTS.progressFile,
    guardrailsFile: flags.guardrails || DEFAULTS.guardrailsFile,
    activityLog: flags["activity-log"] || DEFAULTS.activityLog,
    agentStreamLog: DEFAULTS.agentStreamLog,
    stateFile: flags.state || DEFAULTS.stateFile,
    hintsFile: flags.hints || DEFAULTS.hintsFile,
    // New seed prompt entrypoint (preferred):
    // - `--prompt "<inline text>"`
    // - `--prompt @path/to/file`
    // - `--prompt -` (stdin)
    promptSeed: promptSeedFlag === true ? "" : String(promptSeedFlag || ""),
    agentCommand: normalizeCommand(flags.agent || fm.agent_command || fm.agentCommand || ""),
    testCommand: normalizeCommand(
      fm.test_command || fm.testCommand || phaseDefaults.test_command || phaseDefaults.testCommand || ""
    ),
    autoPhase: coerceBoolean(
      flags["auto-phase"] ?? fm.auto_phase ?? fm.autoPhase,
      DEFAULTS.autoPhase
    ),
    phase: normalizeCommand(flags.phase || fm.phase || ""),
    phaseOnly: coerceBoolean(flags["phase-only"], false),
    skipPhase: normalizeCommand(flags["skip-phase"] || ""),
    preIteration: normalizeCommand(fm.preIteration || fm.pre_iteration || hooks.preIteration || ""),
    postIteration: normalizeCommand(fm.postIteration || fm.post_iteration || hooks.postIteration || ""),
    onFailure: normalizeCommand(fm.onFailure || fm.on_failure || hooks.onFailure || ""),
    gitBranch:
      flags["git-branch"] ||
      fm.git_branch ||
      fm.gitBranch ||
      git.branch ||
      git.git_branch ||
      git.gitBranch ||
      "",
    gitCommit: coerceBoolean(
      flags["git-commit"] ?? fm.git_commit ?? fm.gitCommit ?? git.commit ?? git.git_commit,
      DEFAULTS.gitCommit
    ),
    gitCommitMessage:
      flags["git-commit-message"] ||
      fm.git_commit_message ||
      fm.gitCommitMessage ||
      git.commit_message ||
      git.commitMessage ||
      DEFAULTS.gitCommitMessage,
    gitWorktree: normalizeCommand(
      (gitWorktreeFlag === true ? "" : gitWorktreeFlag) ||
        fm.git_worktree ||
        fm.gitWorktree ||
        git.worktree ||
        git.git_worktree ||
        ""
    ),
    gitWorktreeBranch: normalizeCommand(
      (gitWorktreeBranchFlag === true ? "" : gitWorktreeBranchFlag) ||
        fm.git_worktree_branch ||
        fm.gitWorktreeBranch ||
        git.worktree_branch ||
        git.worktreeBranch ||
        ""
    ),
    maxIterations: clampMin(
      coerceNumber(flags["max-iterations"] || fm.max_iterations, DEFAULTS.maxIterations),
      1
    ),
    maxMinutes: clampMin(coerceNumber(flags["max-minutes"] || fm.max_minutes, DEFAULTS.maxMinutes), 1),
    backoffMs: clampMin(coerceNumber(flags["backoff-ms"] || fm.backoff_ms, DEFAULTS.backoffMs), 0),
    rotateBytes: clampMin(coerceNumber(flags["rotate-bytes"] || fm.rotate_bytes, DEFAULTS.rotateBytes), 1024),
    plain,
    noEmoji: plain ? true : noEmoji,
    noColor: plain ? true : resolveNoColor(flags),
    dryRun: Boolean(flags["dry-run"]),
    stream: Boolean(flags.stream),
    verbose: coerceBoolean(flags.verbose, false),
  };
}

module.exports = {
  DEFAULTS,
  resolveFrom,
  prettyPath,
  materializeConfigPaths,
  formatDuration,
  mergeConfig,
};
