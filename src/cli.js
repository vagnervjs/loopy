const fs = require("fs/promises");
const path = require("path");

const { appendActivity } = require("./activity");
const { parseArgs } = require("./args");
const { DEFAULTS, resolveFrom } = require("./config");
const { runLoop } = require("./loop");
const { printStep } = require("./steps");

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
    "  loopy --version",
    "  loopy run [options]",
    "  loopy loop [options]",
    "  loopy status [options]",
    "  loopy help",
    "",
    "Options:",
    "  --version               Print version and exit",
    "  --task <file>           Task file (default: RALPH_TASK.md)",
    "  --prompt <file>         Prompt file (default: PROMPT.md)",
    "  --progress <file>       Progress file (default: .ralph/progress.md)",
    "  --guardrails <file>     Guardrails file (default: .ralph/guardrails.md)",
    "  --activity-log <file>   Activity log (default: .ralph/activity.log)",
    "  --state <file>          State file (default: .ralph/state.json)",
    "  --agent-cmd <command>   Agent command (overrides task front matter)",
    "  --stream                Mirror agent stdout/stderr to your terminal",
    "  --git-worktree <path>   Use/create git worktree at path (optional)",
    "  --git-worktree-branch <name>  Branch for worktree add/checkout (optional)",
    "  --git-branch <name>     Create/checkout branch before iteration (optional)",
    "  --git-commit            Commit changes after successful iteration (optional)",
    "  --git-commit-message <template>  Commit message template (default shown below)",
    "  --max-iterations <n>    Max iterations (default: 50)",
    "  --max-minutes <n>       Max wall time in minutes (default: 120)",
    "  --backoff-ms <n>        Backoff between iterations (default: 5000)",
    "  --rotate-bytes <n>      Bytes threshold for rotation (default: 150000)",
    "  --dry-run               Build prompt, skip agent execution",
    "  --help, -h              Show help",
    "",
    `Default commit template: ${DEFAULTS.gitCommitMessage}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function runStatus(flags) {
  const cwd = process.cwd();
  const stateFile = resolveFrom(cwd, flags.state || DEFAULTS.stateFile);

  let text = "";
  try {
    text = await fs.readFile(stateFile, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `No Loopy state found at ${path.relative(cwd, stateFile) || stateFile}.\n` +
          "Run `loopy run` or `loopy loop` first."
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
    `Last status: ${(state && state.lastStatus) || "n/a"}`,
    `Last test: ${(state && state.lastTest) || "n/a"}`,
    `Last error: ${(state && state.lastError) || "n/a"}`,
    `Last bytes: ${state && state.lastBytes != null ? state.lastBytes : 0}`,
    `Updated at: ${(state && state.updatedAt) || "n/a"}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function runCli(argv) {
  const { command, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(getLoopyVersion());
    return;
  }

  if (!command || flags.help || command === "help") {
    printHelp();
    return;
  }

  if (command === "status") {
    await runStatus(flags);
    return;
  }

  if (command !== "run" && command !== "loop") {
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

