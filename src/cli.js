const fs = require("fs/promises");
const path = require("path");

const { appendActivity } = require("./activity");
const { parseArgs } = require("./args");
const { DEFAULTS, resolveFrom } = require("./config");
const { appendText, readText, writeText } = require("./fs");
const { runLoop } = require("./loop");
const { printStep } = require("./steps");
const { loadState } = require("./state");

function getLoopyVersion() {
  try {
    // `src/cli.js` lives one level below `package.json`.
    // eslint-disable-next-line global-require
    const pkg = require("../package.json");
    return (pkg && pkg.version) || "";
  } catch (_) {
    return "";
  }
}

function printHelp() {
  const lines = [
    "Loopy",
    "",
    "Usage:",
    "  loopy [command] [options]",
    "  loopy help",
    "  loopy --help, -h",
    "  loopy --version",
    "",
    "Commands:",
    "  loop [options]           Run iterations: build prompt -> run agent -> update state (default)",
    "                           Stops when phase criteria are met, limits hit, guardrails trigger, or signal received",
    "  status                   Show status summary from `.loopy/state.json`",
    "                           Prints iteration/phase + last test/error and last hint",
    '  hint "<text>"            Save a hint for the next prompt',
    '                           Appends to `.loopy/hints.md` (included in the next prompt under "Hints")',
    "  init                     Initialize `.loopy/` files if missing",
    "                           Creates `.loopy/LOOPY_PLAN.md` and `.loopy/hints.md`",
    "  help                     Show help",
    "",
    "Common options:",
    "  --prompt <text>          Seed prompt (inline) to generate/update the plan before looping",
    "  --prompt @<file>         Seed prompt from a file to generate/update the plan before looping",
    "  --prompt -               Seed prompt from stdin to generate/update the plan before looping",
    "  --continue               Resume from saved state (requires existing `.loopy/state.json`); skips git switching",
    `  --plan <file>            Plan doc (default: ${DEFAULTS.taskFile})`,
    "  --agent <command>        Agent command (e.g. cursor-agent; overrides plan front matter)",
    "  --auto-apply             Skip confirmation prompts (apply changes)",
    "  --dry-run                Build prompt, skip agent execution",
    "  --help, -h               Show help",
    "  --version                Print version",
    "",
    "Advanced options:",
    "  Phases:",
    "    --auto-phase             Enable auto-phase planning (default: true; disable with --auto-phase=false)",
    "    --phase <id>             Start/resume at phase id",
    "    --phase-only             Stop after current phase completes",
    "    --skip-phase <ids>       Comma-separated phase ids to skip",
    "  Output:",
    `    --prompt-out <file>      Prompt output file (default: ${DEFAULTS.promptFile})`,
    "    --stream               Mirror agent stdout/stderr to your terminal",
    "  Files:",
    "    --progress <file>        Progress file (default: .loopy/progress.md)",
    "    --guardrails <file>      Guardrails file (default: .loopy/guardrails.md)",
    "    --activity-log <file>    Activity log (default: .loopy/activity.log)",
    "    --state <file>           State file (default: .loopy/state.json)",
    "    --hints <file>           Hints file (default: .loopy/hints.md)",
    "  Git:",
    "    --git-worktree <path>    Use/create git worktree at path (optional)",
    "    --git-worktree-branch <name>   Branch for worktree add/checkout (optional)",
    "    --git-branch <name>      Create/checkout branch before iteration (optional)",
    "    --git-commit             Commit changes after successful iteration (optional)",
    "    --git-commit-message <template> Commit message template (default shown below)",
    "  Limits:",
    "    --max-iterations <n>     Max iterations (default: 50)",
    "    --max-minutes <n>        Max wall time in minutes (default: 120)",
    "    --backoff-ms <n>         Backoff between iterations (default: 5000)",
    "    --rotate-bytes <n>       Bytes threshold for rotation (default: 150000)",
    "",
    `Default commit template: ${DEFAULTS.gitCommitMessage}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function runStatus(flags) {
  const cwd = process.cwd();
  const stateFile = resolveFrom(cwd, flags.state || DEFAULTS.stateFile);
  const hintsFile = resolveFrom(cwd, flags.hints || DEFAULTS.hintsFile);

  let text = "";
  try {
    text = await fs.readFile(stateFile, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `No Loopy state found at ${path.relative(cwd, stateFile) || stateFile}.\n` +
          "Run `loopy loop` first."
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  let state = null;
  try {
    state = JSON.parse(text);
  } catch (err) {
    console.error(
      `Failed to parse Loopy state at ${path.relative(cwd, stateFile) || stateFile}: ${
        err && err.message ? err.message : String(err)
      }`
    );
    process.exitCode = 1;
    return;
  }

  const lines = [
    `Loopy status (${path.relative(cwd, stateFile) || stateFile})`,
    "",
    `Iteration: ${state && state.iteration != null ? state.iteration : 0}`,
    `Current phase: ${(state && state.currentPhase) || "n/a"}`,
    `Last status: ${(state && state.lastStatus) || "n/a"}`,
    `Last test: ${(state && state.lastTest) || "n/a"}`,
    `Last error: ${(state && state.lastError) || "n/a"}`,
    `Last hint: ${(state && state.lastHint) || "n/a"}`,
    `Last hint at: ${(state && state.lastHintAt) || "n/a"}`,
    `Hint count: ${state && state.hintCount != null ? state.hintCount : 0}`,
    `Last bytes: ${state && state.lastBytes != null ? state.lastBytes : 0}`,
    `Updated at: ${(state && state.updatedAt) || "n/a"}`,
    `Hints file: ${path.relative(cwd, hintsFile) || hintsFile}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function runHint(flags) {
  const cwd = process.cwd();
  const text = (flags._ || []).join(" ").trim();
  if (!text) {
    console.error('Missing hint text. Usage: loopy hint "<text>"');
    process.exitCode = 1;
    return;
  }

  const hintsFile = resolveFrom(cwd, flags.hints || DEFAULTS.hintsFile);
  const stateFile = resolveFrom(cwd, flags.state || DEFAULTS.stateFile);

  const entry = `- ${new Date().toISOString()} ${text.replace(/\r?\n/g, " ").trim()}\n`;
  await appendText(hintsFile, entry);

  const loaded = await loadState(stateFile);
  const state = loaded.state || {};
  const next = {
    ...state,
    lastHint: text,
    lastHintAt: new Date().toISOString(),
    hintCount: (state.hintCount || 0) + 1,
    updatedAt: new Date().toISOString(),
    startedAt: state.startedAt || new Date().toISOString(),
  };
  await writeText(stateFile, JSON.stringify(next, null, 2) + "\n");

  console.log(`Hint saved to ${path.relative(cwd, hintsFile) || hintsFile}`);
}

async function runInit(flags) {
  const cwd = process.cwd();
  const loopyDir = resolveFrom(cwd, DEFAULTS.loopyDir);
  const hintsFile = resolveFrom(cwd, flags.hints || DEFAULTS.hintsFile);
  const planFile = resolveFrom(cwd, flags.plan || DEFAULTS.taskFile);

  await fs.mkdir(loopyDir, { recursive: true });

  const created = [];

  // Hints file (append-only).
  const existingHints = await readText(hintsFile);
  if (!existingHints) {
    await writeText(hintsFile, "# Loopy Hints\n\n");
    created.push(path.relative(cwd, hintsFile) || hintsFile);
  }

  // Plan file scaffold (do not overwrite).
  const existingPlan = await readText(planFile);
  if (!existingPlan) {
    const template = [
      "---",
      "agent_command: \"cursor-agent\"",
      "test_command: \"npm test\"",
      "max_iterations: 10",
      "max_minutes: 60",
      "backoff_ms: 5000",
      "rotate_bytes: 150000",
      "phase_defaults:",
      "  stop_on: all_checked",
      "  test_command: \"npm test\"",
      "phases:",
      "  - id: plan",
      "    title: Plan",
      "  - id: implement",
      "    title: Implement",
      "  - id: verify",
      "    title: Verify",
      "    stop_on: [all_checked, tests_pass]",
      "    test_command: \"npm test\"",
      "---",
      "",
      "# Plan",
      "",
      "## Phase: plan",
      "<!-- loopy:phase plan -->",
      "- [ ] Describe the goal and constraints.",
      "",
      "## Phase: implement",
      "<!-- loopy:phase implement -->",
      "- [ ] Implement the requested changes.",
      "",
      "## Phase: verify",
      "<!-- loopy:phase verify -->",
      "- [ ] Run tests and validate behavior.",
      "",
    ].join("\n");
    await writeText(planFile, template);
    created.push(path.relative(cwd, planFile) || planFile);
  }

  if (created.length) {
    console.log(["Initialized:", ...created.map((p) => `- ${p}`)].join("\n"));
  } else {
    console.log("Nothing to init (files already exist).");
  }
}

async function runCli(argv) {
  let { command, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(getLoopyVersion());
    return;
  }

  if (flags.help || command === "help") {
    printHelp();
    return;
  }

  // Default to `loop` when no subcommand is provided.
  if (!command) command = "loop";

  if (command === "status") {
    await runStatus(flags);
    return;
  }

  if (command === "hint") {
    await runHint(flags);
    return;
  }

  if (command === "init") {
    await runInit(flags);
    return;
  }

  if (command === "run") {
    console.error("Unsupported command. For a single iteration, use `loopy loop --max-iterations 1`.");
    process.exitCode = 1;
    return;
  }

  if (command !== "loop") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const stopSignal = { stopRequested: false };
  let currentActivityLog = DEFAULTS.activityLog;

  process.on("SIGINT", async () => {
    stopSignal.stopRequested = true;
    printStep("SIGINT received. Stopping.");
    try {
      await appendActivity(currentActivityLog, ["SIGINT received. Stopping."]);
    } catch (_) {
      // ignore
    }
  });

  process.on("SIGTERM", async () => {
    stopSignal.stopRequested = true;
    printStep("SIGTERM received. Stopping.");
    try {
      await appendActivity(currentActivityLog, ["SIGTERM received. Stopping."]);
    } catch (_) {
      // ignore
    }
  });

  await runLoop(command, flags, {
    stopSignal,
    onActivityLog: (logPath) => {
      currentActivityLog = logPath || currentActivityLog;
    },
  });
}

module.exports = {
  runCli,
};

