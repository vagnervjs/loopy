const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULTS = {
  taskFile: ".loopy/LOOPY_PLAN.md",
  promptFile: ".loopy/PROMPT.md",
  prdFile: ".loopy/PRD.md",
  loopyDir: ".loopy",
  progressFile: ".loopy/progress.md",
  guardrailsFile: ".loopy/guardrails.md",
  activityLog: ".loopy/activity.log",
  agentStreamLog: ".loopy/agent_stream.log",
  stateFile: ".loopy/state.json",
  hintsFile: ".loopy/hints.md",
  guardrailRepeatLimit: 20,
  guardrailCooldownMs: 60000,
  maxIterations: 50,
  maxMinutes: 120,
  backoffMs: 5000,
  rotateBytes: 150000,
  maxOutputBytes: 1024 * 1024,
  gitCommit: true,
  gitCommitMessage: "loopy: {change_type} {task_summary}",
  autoPhase: true,
  confirm: false,
  stream: true,
  verbose: true,
  singleTaskMode: true,
  mode: "build",
  promptTemplate: "",
  bootstrapAgents: true,
  includeLastOutput: false,
  generatePrd: true,
  fixBudget: 1,
  allowBlocked: true,
  blockedThreshold: 3,
};

const GLOBAL_CONFIG_FILES = ["config.yml", "config.yaml", "config.json"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseGlobalConfig(raw, filePath) {
  if (!String(raw || "").trim()) return {};
  let parsed = null;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse global config at ${filePath}: ${err && err.message ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Global config at ${filePath} must be a YAML/JSON object.`);
  }
  return parsed;
}

function pickDefinedKey(obj, keys) {
  const target = obj && typeof obj === "object" ? obj : null;
  if (!target) return "";
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      return key;
    }
  }
  return "";
}

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
    prdFile: resolveFrom(nextCwd, config.prdFile || DEFAULTS.prdFile),
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

function pickDefined(obj, keys) {
  const target = obj && typeof obj === "object" ? obj : null;
  if (!target) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      return target[key];
    }
  }
  return undefined;
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

function resolveNoColor(flags, defaults) {
  const hasFlag = Object.prototype.hasOwnProperty.call(flags || {}, "no-color");
  if (hasFlag) {
    return coerceBoolean(flags["no-color"], true);
  }
  const defaultValue = pickDefined(defaults, ["no-color", "no_color", "noColor"]);
  if (defaultValue !== undefined) {
    return coerceBoolean(defaultValue, false);
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

async function loadGlobalConfig() {
  const configDir = path.join(os.homedir(), ".loopy");
  for (const filename of GLOBAL_CONFIG_FILES) {
    const filePath = path.join(configDir, filename);
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    const parsed = parseGlobalConfig(raw, filePath);
    const config = isPlainObject(parsed.defaults) ? parsed.defaults : parsed;
    return { config, path: filePath };
  }
  return { config: {}, path: "" };
}

function detectConfigFormat(filePath) {
  return path.extname(filePath).toLowerCase() === ".json" ? "json" : "yaml";
}

async function loadGlobalConfigSource() {
  const configDir = path.join(os.homedir(), ".loopy");
  for (const filename of GLOBAL_CONFIG_FILES) {
    const filePath = path.join(configDir, filename);
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    const parsed = parseGlobalConfig(raw, filePath);
    return { config: parsed, path: filePath, format: detectConfigFormat(filePath), exists: true };
  }
  const fallbackPath = path.join(configDir, GLOBAL_CONFIG_FILES[0]);
  return { config: {}, path: fallbackPath, format: detectConfigFormat(fallbackPath), exists: false };
}

async function persistGlobalAgentCommand(agentCommand) {
  const normalized = normalizeCommand(agentCommand);
  if (!normalized) return { saved: false, reason: "missing-agent" };
  const source = await loadGlobalConfigSource();
  const root = isPlainObject(source.config) ? { ...source.config } : {};
  const hasDefaults = isPlainObject(root.defaults);
  const defaults = hasDefaults ? { ...root.defaults } : null;
  const target = hasDefaults ? defaults : root;
  const key = pickDefinedKey(target, ["agent", "agent_command", "agentCommand"]) || "agent";
  const current = target[key] == null ? "" : String(target[key]).trim();
  if (current === normalized) {
    return { saved: false, reason: "unchanged", path: source.path };
  }
  target[key] = normalized;
  if (hasDefaults) {
    root.defaults = target;
  }
  await fs.mkdir(path.dirname(source.path), { recursive: true });
  const payload =
    source.format === "json"
      ? JSON.stringify(root, null, 2) + "\n"
      : `${yaml.dump(root, { lineWidth: 120 }).trimEnd()}\n`;
  await fs.writeFile(source.path, payload, "utf8");
  return { saved: true, path: source.path };
}

function mergeConfig(flags, frontMatter, defaults = {}) {
  const fm = frontMatter || {};
  const def = defaults || {};
  const hooks = fm.hooks || {};
  const defaultHooks = def.hooks || {};
  const git = fm.git || {};
  const defaultGit = def.git || {};
  const phaseDefaults = fm.phase_defaults || fm.phaseDefaults || {};
  const defaultPhaseDefaults = def.phase_defaults || def.phaseDefaults || {};
  const hasPromptSeed = Object.prototype.hasOwnProperty.call(flags, "prompt");
  const promptSeedFlag = hasPromptSeed ? flags.prompt : undefined;
  const promptOutFlag = flags["prompt-out"];
  const promptOutDefault = pickDefined(def, ["prompt-out", "prompt_out", "promptOut", "promptFile", "prompt_file"]);
  const gitWorktreeFlag = flags["git-worktree"];
  const gitWorktreeBranchFlag = flags["git-worktree-branch"];
  const planFileFlag = flags["plan-file"] ?? flags["plan-doc"];
  const plain = coerceBoolean(flags.plain ?? pickDefined(def, ["plain"]), false);
  const noEmoji = coerceBoolean(flags["no-emoji"] ?? pickDefined(def, ["no-emoji", "no_emoji", "noEmoji"]), false);
  const streamDefault = pickDefined(def, ["stream"]);
  const verboseDefault = pickDefined(def, ["verbose"]);
  const resumeDefault = pickDefined(def, ["resume"]);
  const confirmDefault = pickDefined(def, ["confirm"]);
  const taskFileDefault =
    pickDefined(def, ["plan_file", "planFile", "plan_doc", "planDoc", "taskFile", "task_file", "plan"]) ||
    DEFAULTS.taskFile;
  const prdFileDefault = pickDefined(def, ["prd", "prd_file", "prdFile"]) || DEFAULTS.prdFile;
  const promptOutValue = promptOutFlag === undefined ? promptOutDefault : promptOutFlag;
  const progressDefault = pickDefined(def, ["progress", "progress_file", "progressFile"]) || DEFAULTS.progressFile;
  const guardrailsDefault = pickDefined(def, ["guardrails", "guardrails_file", "guardrailsFile"]) || DEFAULTS.guardrailsFile;
  const activityLogDefault = pickDefined(def, ["activity_log", "activityLog", "activityLogFile", "activityLogPath"]) || DEFAULTS.activityLog;
  const stateDefault = pickDefined(def, ["state", "state_file", "stateFile"]) || DEFAULTS.stateFile;
  const hintsDefault = pickDefined(def, ["hints", "hints_file", "hintsFile"]) || DEFAULTS.hintsFile;
  const loopyDirDefault = pickDefined(def, ["loopy_dir", "loopyDir"]) || DEFAULTS.loopyDir;
  const agentCommandDefault = pickDefined(def, ["agent", "agent_command", "agentCommand"]);
  const testCommandDefault = pickDefined(def, ["test_command", "testCommand"]);
  const autoPhaseDefault = pickDefined(def, ["auto_phase", "autoPhase"]);
  const phaseDefault = pickDefined(def, ["phase"]);
  const phaseOnlyDefault = pickDefined(def, ["phase_only", "phaseOnly"]);
  const skipPhaseDefault = pickDefined(def, ["skip_phase", "skipPhase"]);
  const preIterationDefault = pickDefined(def, ["preIteration", "pre_iteration"]);
  const postIterationDefault = pickDefined(def, ["postIteration", "post_iteration"]);
  const onFailureDefault = pickDefined(def, ["onFailure", "on_failure"]);
  const modeDefault = pickDefined(def, ["mode"]);
  const promptTemplateDefault = pickDefined(def, ["prompt_template", "promptTemplate"]);
  const bootstrapAgentsDefault = pickDefined(def, ["bootstrap_agents", "bootstrapAgents"]);
  const includeLastOutputDefault = pickDefined(def, ["include_last_output", "includeLastOutput"]);
  const generatePrdDefault = pickDefined(def, ["generate_prd", "generatePrd"]);
  const gitBranchDefault =
    pickDefined(def, ["git_branch", "gitBranch"]) ||
    pickDefined(defaultGit, ["branch", "git_branch", "gitBranch"]);
  const gitCommitDefault =
    pickDefined(def, ["git_commit", "gitCommit"]) ||
    pickDefined(defaultGit, ["commit", "git_commit", "gitCommit"]);
  const gitCommitMessageDefault =
    pickDefined(def, ["git_commit_message", "gitCommitMessage"]) ||
    pickDefined(defaultGit, ["commit_message", "commitMessage", "git_commit_message", "gitCommitMessage"]);
  const gitWorktreeDefault =
    pickDefined(def, ["git_worktree", "gitWorktree"]) ||
    pickDefined(defaultGit, ["worktree", "git_worktree", "gitWorktree"]);
  const gitWorktreeBranchDefault =
    pickDefined(def, ["git_worktree_branch", "gitWorktreeBranch"]) ||
    pickDefined(defaultGit, ["worktree_branch", "worktreeBranch", "git_worktree_branch", "gitWorktreeBranch"]);
  const maxIterationsDefault = pickDefined(def, ["max_iterations", "maxIterations"]);
  const maxMinutesDefault = pickDefined(def, ["max_minutes", "maxMinutes"]);
  const backoffMsDefault = pickDefined(def, ["backoff_ms", "backoffMs"]);
  const rotateBytesDefault = pickDefined(def, ["rotate_bytes", "rotateBytes"]);
  const guardrailRepeatLimitDefault = pickDefined(def, [
    "guardrail_repeat_limit",
    "guardrailRepeatLimit",
    "repeat_limit",
    "repeatLimit",
  ]);
  const guardrailCooldownMsDefault = pickDefined(def, [
    "guardrail_cooldown_ms",
    "guardrailCooldownMs",
    "cooldown_ms",
    "cooldownMs",
  ]);
  const dryRunDefault = pickDefined(def, ["dry_run", "dryRun"]);
  const singleTaskModeDefault = pickDefined(def, ["single_task_mode", "singleTaskMode", "singleTask"]);
  const fixBudgetDefault = pickDefined(def, ["fix_budget", "fixBudget"]);
  const allowBlockedDefault = pickDefined(def, ["allow_blocked", "allowBlocked"]);
  const blockedThresholdDefault = pickDefined(def, ["blocked_threshold", "blockedThreshold"]);
  return {
    cwd: process.cwd(),
    resume: coerceBoolean(flags.resume ?? resumeDefault, false),
    confirm: coerceBoolean(flags.confirm ?? confirmDefault, DEFAULTS.confirm),
    // NOTE: `--generate-prd` controls whether to generate a PRD before the plan. Use `--plan-file` to override the plan doc path.
    taskFile: planFileFlag || taskFileDefault,
    // NOTE: `--prompt` is reserved for the seed prompt. Use `--prompt-out` for the generated prompt markdown file.
    promptFile: (promptOutValue === true ? "" : String(promptOutValue || "")) || DEFAULTS.promptFile,
    prdFile: prdFileDefault,
    loopyDir: loopyDirDefault,
    progressFile: flags.progress || progressDefault,
    guardrailsFile: flags.guardrails || guardrailsDefault,
    activityLog: flags["activity-log"] || activityLogDefault,
    agentStreamLog: DEFAULTS.agentStreamLog,
    stateFile: flags.state || stateDefault,
    hintsFile: flags.hints || hintsDefault,
    // New seed prompt entrypoint (preferred):
    // - `--prompt "<inline text>"`
    // - `--prompt @path/to/file`
    // - `--prompt -` (stdin)
    promptSeed: promptSeedFlag === true ? "" : String(promptSeedFlag || ""),
    agentCommand: normalizeCommand(flags.agent || fm.agent_command || fm.agentCommand || agentCommandDefault || ""),
    testCommand: normalizeCommand(
      flags["test-command"] ||
        fm.test_command ||
        fm.testCommand ||
        phaseDefaults.test_command ||
        phaseDefaults.testCommand ||
        testCommandDefault ||
        defaultPhaseDefaults.test_command ||
        defaultPhaseDefaults.testCommand ||
        ""
    ),
    autoPhase: coerceBoolean(
      flags["auto-phase"] ?? fm.auto_phase ?? fm.autoPhase ?? autoPhaseDefault,
      DEFAULTS.autoPhase
    ),
    phase: normalizeCommand(flags.phase || fm.phase || phaseDefault || ""),
    phaseOnly: coerceBoolean(flags["phase-only"] ?? phaseOnlyDefault, false),
    skipPhase: normalizeCommand(flags["skip-phase"] || skipPhaseDefault || ""),
    preIteration: normalizeCommand(
      fm.preIteration ||
        fm.pre_iteration ||
        hooks.preIteration ||
        preIterationDefault ||
        defaultHooks.preIteration ||
        ""
    ),
    postIteration: normalizeCommand(
      fm.postIteration ||
        fm.post_iteration ||
        hooks.postIteration ||
        postIterationDefault ||
        defaultHooks.postIteration ||
        ""
    ),
    onFailure: normalizeCommand(
      fm.onFailure || fm.on_failure || hooks.onFailure || onFailureDefault || defaultHooks.onFailure || ""
    ),
    gitBranch:
      flags["git-branch"] ||
      fm.git_branch ||
      fm.gitBranch ||
      git.branch ||
      git.git_branch ||
      git.gitBranch ||
      gitBranchDefault ||
      "",
    gitCommit: coerceBoolean(
      flags["git-commit"] ?? fm.git_commit ?? fm.gitCommit ?? git.commit ?? git.git_commit ?? gitCommitDefault,
      DEFAULTS.gitCommit
    ),
    gitCommitMessage:
      flags["git-commit-message"] ||
      fm.git_commit_message ||
      fm.gitCommitMessage ||
      git.commit_message ||
      git.commitMessage ||
      gitCommitMessageDefault ||
      DEFAULTS.gitCommitMessage,
    gitWorktree: normalizeCommand(
      (gitWorktreeFlag === true ? "" : gitWorktreeFlag) ||
        fm.git_worktree ||
        fm.gitWorktree ||
        git.worktree ||
        git.git_worktree ||
        gitWorktreeDefault ||
        ""
    ),
    gitWorktreeBranch: normalizeCommand(
      (gitWorktreeBranchFlag === true ? "" : gitWorktreeBranchFlag) ||
        fm.git_worktree_branch ||
        fm.gitWorktreeBranch ||
        git.worktree_branch ||
        git.worktreeBranch ||
        gitWorktreeBranchDefault ||
        ""
    ),
    maxIterations: clampMin(
      coerceNumber(flags["max-iterations"] || fm.max_iterations || maxIterationsDefault, DEFAULTS.maxIterations),
      1
    ),
    maxMinutes: clampMin(
      coerceNumber(flags["max-minutes"] || fm.max_minutes || maxMinutesDefault, DEFAULTS.maxMinutes),
      1
    ),
    backoffMs: clampMin(coerceNumber(flags["backoff-ms"] || fm.backoff_ms || backoffMsDefault, DEFAULTS.backoffMs), 0),
    rotateBytes: clampMin(
      coerceNumber(flags["rotate-bytes"] || fm.rotate_bytes || rotateBytesDefault, DEFAULTS.rotateBytes),
      1024
    ),
    guardrailRepeatLimit: clampMin(
      coerceNumber(
        flags["guardrail-repeat-limit"] ||
          fm.guardrail_repeat_limit ||
          fm.guardrailRepeatLimit ||
          guardrailRepeatLimitDefault,
        DEFAULTS.guardrailRepeatLimit
      ),
      0
    ),
    guardrailCooldownMs: clampMin(
      coerceNumber(
        flags["guardrail-cooldown-ms"] ||
          fm.guardrail_cooldown_ms ||
          fm.guardrailCooldownMs ||
          guardrailCooldownMsDefault,
        DEFAULTS.guardrailCooldownMs
      ),
      0
    ),
    plain,
    noEmoji: plain ? true : noEmoji,
    noColor: plain ? true : resolveNoColor(flags, def),
    dryRun: coerceBoolean(flags["dry-run"] ?? dryRunDefault, false),
    stream: flags["no-stream"] !== undefined ? !coerceBoolean(flags["no-stream"], false) : coerceBoolean(streamDefault, DEFAULTS.stream),
    verbose: coerceBoolean(flags.verbose ?? verboseDefault, DEFAULTS.verbose),
    singleTaskMode: coerceBoolean(
      flags["single-task"] ?? fm.single_task_mode ?? fm.singleTaskMode ?? singleTaskModeDefault,
      DEFAULTS.singleTaskMode
    ),
    mode: String(flags.mode ?? fm.mode ?? modeDefault ?? DEFAULTS.mode).trim() || DEFAULTS.mode,
    promptTemplate: normalizeCommand(
      flags["prompt-template"] ?? fm.prompt_template ?? fm.promptTemplate ?? promptTemplateDefault ?? ""
    ),
    bootstrapAgents: coerceBoolean(
      flags["no-bootstrap-agents"] !== undefined ? !coerceBoolean(flags["no-bootstrap-agents"], false) : bootstrapAgentsDefault,
      DEFAULTS.bootstrapAgents
    ),
    generatePrd: coerceBoolean(flags["generate-prd"] ?? generatePrdDefault, DEFAULTS.generatePrd),
    includeLastOutput: coerceBoolean(
      flags["include-last-output"] ?? fm.include_last_output ?? fm.includeLastOutput ?? includeLastOutputDefault,
      DEFAULTS.includeLastOutput
    ),
    fixBudget: clampMin(
      coerceNumber(
        flags["fix-budget"] ?? fm.fix_budget ?? fm.fixBudget ?? fixBudgetDefault,
        DEFAULTS.fixBudget
      ),
      0
    ),
    allowBlocked: coerceBoolean(
      flags["allow-blocked"] ?? fm.allow_blocked ?? fm.allowBlocked ?? allowBlockedDefault,
      DEFAULTS.allowBlocked
    ),
    blockedThreshold: clampMin(
      coerceNumber(
        flags["blocked-threshold"] ?? fm.blocked_threshold ?? fm.blockedThreshold ?? blockedThresholdDefault,
        DEFAULTS.blockedThreshold
      ),
      1
    ),
  };
}

module.exports = {
  DEFAULTS,
  resolveFrom,
  prettyPath,
  materializeConfigPaths,
  formatDuration,
  loadGlobalConfig,
  persistGlobalAgentCommand,
  mergeConfig,
};
