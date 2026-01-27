const path = require("path");

const DEFAULTS = {
  taskFile: "LOOPY_TASK.md",
  promptFile: "PROMPT.md",
  loopyDir: ".loopy",
  progressFile: ".loopy/progress.md",
  guardrailsFile: ".loopy/guardrails.md",
  activityLog: ".loopy/activity.log",
  agentStreamLog: ".loopy/agent_stream.log",
  stateFile: ".loopy/state.json",
  maxIterations: 50,
  maxMinutes: 120,
  backoffMs: 5000,
  rotateBytes: 150000,
  maxOutputBytes: 1024 * 1024,
  gitCommitMessage: "loopy: {change_type} {task_summary}",
  autoPhase: true,
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
  const taskPromptFlag = flags["task-prompt"];
  const taskFileFlag = flags["task-file"] ?? flags["task-prompt-file"];
  return {
    cwd: process.cwd(),
    taskFile: flags.task || DEFAULTS.taskFile,
    promptFile: flags.prompt || DEFAULTS.promptFile,
    loopyDir: DEFAULTS.loopyDir,
    progressFile: flags.progress || DEFAULTS.progressFile,
    guardrailsFile: flags.guardrails || DEFAULTS.guardrailsFile,
    activityLog: flags["activity-log"] || DEFAULTS.activityLog,
    agentStreamLog: DEFAULTS.agentStreamLog,
    stateFile: flags.state || DEFAULTS.stateFile,
    agentCommand: normalizeCommand(flags["agent-cmd"] || fm.agent_command || fm.agentCommand || ""),
    testCommand: normalizeCommand(fm.test_command || fm.testCommand || ""),
    taskPrompt: taskPromptFlag === true ? "" : String(taskPromptFlag || ""),
    taskPromptFile: taskFileFlag === true ? "" : String(taskFileFlag || ""),
    autoApply: coerceBoolean(flags["auto-apply"], false),
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
    gitCommit: coerceBoolean(flags["git-commit"] ?? fm.git_commit ?? fm.gitCommit ?? git.commit ?? git.git_commit),
    gitCommitMessage:
      flags["git-commit-message"] ||
      fm.git_commit_message ||
      fm.gitCommitMessage ||
      git.commit_message ||
      git.commitMessage ||
      DEFAULTS.gitCommitMessage,
    gitWorktree:
      flags["git-worktree"] ||
      fm.git_worktree ||
      fm.gitWorktree ||
      git.worktree ||
      git.git_worktree ||
      "",
    gitWorktreeBranch:
      flags["git-worktree-branch"] ||
      fm.git_worktree_branch ||
      fm.gitWorktreeBranch ||
      git.worktree_branch ||
      git.worktreeBranch ||
      "",
    maxIterations: clampMin(
      coerceNumber(flags["max-iterations"] || fm.max_iterations, DEFAULTS.maxIterations),
      1
    ),
    maxMinutes: clampMin(coerceNumber(flags["max-minutes"] || fm.max_minutes, DEFAULTS.maxMinutes), 1),
    backoffMs: clampMin(coerceNumber(flags["backoff-ms"] || fm.backoff_ms, DEFAULTS.backoffMs), 0),
    rotateBytes: clampMin(coerceNumber(flags["rotate-bytes"] || fm.rotate_bytes, DEFAULTS.rotateBytes), 1024),
    dryRun: Boolean(flags["dry-run"]),
    stream: Boolean(flags.stream),
  };
}

module.exports = {
  DEFAULTS,
  resolveFrom,
  prettyPath,
  materializeConfigPaths,
  normalizeCommand,
  coerceNumber,
  coerceBoolean,
  clampMin,
  formatDuration,
  mergeConfig,
};
