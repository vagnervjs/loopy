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

function maxStringLength(values) {
  let max = 0;
  for (const v of values || []) {
    const len = String(v || "").length;
    if (len > max) max = len;
  }
  return max;
}

function formatHelpRows(rows, { indent, labelWidth, gap } = {}) {
  const ind = indent == null ? "" : String(indent);
  const g = gap == null ? 2 : Number(gap);
  const w = labelWidth == null ? maxStringLength((rows || []).map((r) => r.label)) : Number(labelWidth);

  const lines = [];
  for (const row of rows || []) {
    if (!row) continue;
    const label = String(row.label || "");
    const descLines = String(row.desc || "").split(/\r?\n/);
    if (!descLines.length) {
      lines.push(`${ind}${label.padEnd(w + g)}`.trimEnd());
      continue;
    }
    lines.push(`${ind}${label.padEnd(w + g)}${descLines[0]}`);
    for (let i = 1; i < descLines.length; i += 1) {
      lines.push(`${ind}${"".padEnd(w + g)}${descLines[i]}`);
    }
  }
  return lines;
}

function printHelp() {
  const commands = [
    {
      label: "status",
      desc: "Show status summary from `.loopy/state.json`\nPrints iteration/phase + last test/error and last hint",
    },
    {
      label: 'hint "<text>"',
      desc: "Save a hint for the next prompt\nAppends to `.loopy/hints.md` (included in the next prompt under \"Hints\")\nUse --reset to clear all hints, --pop to remove the last hint",
    },
    { label: "init", desc: "Initialize `.loopy/` files if missing\nCreates `.loopy/LOOPY_PLAN.md` and `.loopy/hints.md`" },
    { label: "help", desc: "Show help" },
  ];

  const commonOptions = [
    { label: "--prompt <text>", desc: "Seed prompt (inline) to generate/update the plan before looping" },
    { label: "--prompt @<file>", desc: "Seed prompt from a file to generate/update the plan before looping" },
    { label: "--prompt -", desc: "Seed prompt from stdin to generate/update the plan before looping" },
    {
      label: "--continue",
      desc: "Resume from saved state (requires existing `.loopy/state.json`); skips git switching",
    },
    { label: "--plan <file>", desc: `Plan doc (default: ${DEFAULTS.taskFile})` },
    { label: "--agent <command>", desc: "Agent command (e.g. cursor-agent; overrides plan front matter)" },
    { label: "--confirm", desc: "Ask before writing or applying plan updates" },
    { label: "--dry-run", desc: "Build prompt, skip agent execution" },
    { label: "--help, -h", desc: "Show help" },
    { label: "--version", desc: "Print version" },
  ];

  const advancedByGroup = {
    Phases: [
      {
        label: "--auto-phase",
        desc: "Enable auto-phase planning (default: true; disable with --auto-phase=false)",
      },
      { label: "--phase <id>", desc: "Start/resume at phase id" },
      { label: "--phase-only", desc: "Stop after current phase completes" },
      { label: "--skip-phase <ids>", desc: "Comma-separated phase ids to skip" },
    ],
    Output: [
      { label: "--prompt-out <file>", desc: `Prompt output file (default: ${DEFAULTS.promptFile})` },
      { label: "--stream", desc: "Mirror agent stdout/stderr to your terminal" },
    ],
    Files: [
      { label: "--progress <file>", desc: "Progress file (default: .loopy/progress.md)" },
      { label: "--guardrails <file>", desc: "Guardrails file (default: .loopy/guardrails.md)" },
      { label: "--activity-log <file>", desc: "Activity log (default: .loopy/activity.log)" },
      { label: "--state <file>", desc: "State file (default: .loopy/state.json)" },
      { label: "--hints <file>", desc: "Hints file (default: .loopy/hints.md)" },
    ],
    Git: [
      { label: "--git-worktree <path>", desc: "Use/create git worktree at path (optional)" },
      { label: "--git-worktree-branch <name>", desc: "Branch for worktree add/checkout (optional)" },
      {
        label: "--git-branch <name>",
        desc: "Create/checkout branch before iteration (default: prompt when in git repo)",
      },
      {
        label: "--git-commit",
        desc: "Commit changes after successful iteration (default: true; disable with --git-commit=false)",
      },
      {
        label: "--git-commit-message <template>",
        desc: `Commit message template (default: ${DEFAULTS.gitCommitMessage})`,
      },
    ],
    Limits: [
      { label: "--max-iterations <n>", desc: "Max iterations (default: 50)" },
      { label: "--max-minutes <n>", desc: "Max wall time in minutes (default: 120)" },
      { label: "--backoff-ms <n>", desc: "Backoff between iterations (default: 5000)" },
      { label: "--rotate-bytes <n>", desc: "Bytes threshold for rotation (default: 150000)" },
    ],
  };

  const lines = [
    "Loopy",
    "",
    "Usage:",
    "  loopy [options]",
    "  loopy status",
    '  loopy hint "<text>"',
    "  loopy init",
    "  loopy help",
    "  loopy --help, -h",
    "  loopy --version",
    "",
    "Default behavior:",
    "  Run iterations: build prompt -> run agent -> update state",
    "  Stops when phase criteria are met, limits hit, guardrails trigger, or signal received",
    "",
    "Commands:",
    ...formatHelpRows(commands, { indent: "  ", gap: 2 }),
    "",
    "Common options:",
    ...formatHelpRows(commonOptions, { indent: "  ", gap: 2 }),
    "",
    "Advanced options:",
    ...(() => {
      const all = Object.values(advancedByGroup).flat();
      const labelWidth = maxStringLength(all.map((r) => r.label));
      const out = [];
      for (const [group, rows] of Object.entries(advancedByGroup)) {
        out.push(`  ${group}:`);
        out.push(...formatHelpRows(rows, { indent: "    ", labelWidth, gap: 2 }));
      }
      return out;
    })(),
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
          "Run `loopy` first."
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
  const hintsFile = resolveFrom(cwd, flags.hints || DEFAULTS.hintsFile);
  const stateFile = resolveFrom(cwd, flags.state || DEFAULTS.stateFile);

  // Handle --reset flag: clear hints and reset state
  if (flags.reset) {
    await writeText(hintsFile, "# Loopy Hints\n\n");

    const loaded = await loadState(stateFile);
    const state = loaded.state || {};
    const next = {
      ...state,
      lastHint: null,
      lastHintAt: null,
      hintCount: 0,
      updatedAt: new Date().toISOString(),
      startedAt: state.startedAt || new Date().toISOString(),
    };
    await writeText(stateFile, JSON.stringify(next, null, 2) + "\n");

    console.log(`Hints reset (${path.relative(cwd, hintsFile) || hintsFile})`);
    return;
  }

  // Handle --pop flag: remove the last hint
  if (flags.pop) {
    const content = (await readText(hintsFile)) || "";
    const lines = content.split(/\r?\n/);

    // Find all hint lines (starting with "- ")
    const hintIndices = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith("- ")) {
        hintIndices.push(i);
      }
    }

    if (hintIndices.length === 0) {
      console.log("No hints to pop.");
      return;
    }

    // Remove the last hint line
    const lastHintIdx = hintIndices[hintIndices.length - 1];
    lines.splice(lastHintIdx, 1);

    // Write back the file
    await writeText(hintsFile, lines.join("\n"));

    // Update state
    const loaded = await loadState(stateFile);
    const state = loaded.state || {};
    const newHintCount = Math.max(0, (state.hintCount || 0) - 1);

    // Determine the new lastHint/lastHintAt from the remaining hints
    let newLastHint = null;
    let newLastHintAt = null;
    if (hintIndices.length > 1) {
      // There's still at least one hint left
      const prevHintIdx = hintIndices[hintIndices.length - 2];
      const prevHintLine = lines[prevHintIdx] || "";
      // Parse "- TIMESTAMP text" format
      const match = prevHintLine.match(/^- (\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)\s+(.*)$/);
      if (match) {
        newLastHintAt = match[1];
        newLastHint = match[2];
      }
    }

    const next = {
      ...state,
      lastHint: newLastHint,
      lastHintAt: newLastHintAt,
      hintCount: newHintCount,
      updatedAt: new Date().toISOString(),
      startedAt: state.startedAt || new Date().toISOString(),
    };
    await writeText(stateFile, JSON.stringify(next, null, 2) + "\n");

    console.log(`Last hint removed (${path.relative(cwd, hintsFile) || hintsFile})`);
    return;
  }

  const text = (flags._ || []).join(" ").trim();
  if (!text) {
    console.error('Missing hint text. Usage: loopy hint "<text>"');
    process.exitCode = 1;
    return;
  }

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

  const isDefault = !command;

  if (command === "loop") {
    console.error("The `loop` subcommand has been removed. Run `loopy` without a command instead.");
    printHelp();
    process.exitCode = 1;
    return;
  }

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
    console.error("Unsupported command. For a single iteration, use `loopy --max-iterations 1`.");
    process.exitCode = 1;
    return;
  }

  if (!isDefault) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const stopSignal = { stopRequested: false };
  let currentActivityLog = DEFAULTS.activityLog;

  process.on("SIGINT", async () => {
    stopSignal.stopRequested = true;
    printStep("signal: SIGINT received; stopping", { level: "warn" });
    try {
      await appendActivity(currentActivityLog, ["SIGINT received. Stopping."]);
    } catch (_) {
      // ignore
    }
  });

  process.on("SIGTERM", async () => {
    stopSignal.stopRequested = true;
    printStep("signal: SIGTERM received; stopping", { level: "warn" });
    try {
      await appendActivity(currentActivityLog, ["SIGTERM received. Stopping."]);
    } catch (_) {
      // ignore
    }
  });

  await runLoop("loop", flags, {
    stopSignal,
    onActivityLog: (logPath) => {
      currentActivityLog = logPath || currentActivityLog;
    },
  });
}

module.exports = {
  runCli,
};

