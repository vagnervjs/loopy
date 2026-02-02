const fs = require("fs/promises");
const path = require("path");

const { appendActivity } = require("./activity");
const { parseArgs } = require("./args");
const { DEFAULTS, resolveFrom } = require("./config");
const { appendText, readText, writeText } = require("./fs");
const { runLoop } = require("./loop");
const { formatDurationMs, printStep } = require("./steps");
const { loadState } = require("./state");
const { parseTask, getCurrentTask } = require("./task");

const STATUS_ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

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

function createStopSignal() {
  const listeners = new Set();
  const signal = {
    stopRequested: false,
    onStop: (listener) => {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestStop: (reason) => {
      if (signal.stopRequested) return;
      signal.stopRequested = true;
      for (const listener of Array.from(listeners)) {
        try {
          listener(reason);
        } catch (_) {
          // ignore
        }
      }
    },
  };
  return signal;
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
    { label: "reset", desc: "Archive all files from `.loopy/` to `.loopy/archive/reset-<timestamp>/`\nClears loop state for a fresh start" },
    { label: "help", desc: "Show help" },
  ];

  const commonOptions = [
    { label: "--mode <build|plan>", desc: "Run in build mode (default) or plan-only mode" },
    { label: "--prompt <text>", desc: "Seed prompt (inline) for plan/PRD generation" },
    { label: "--prompt @<file>", desc: "Seed prompt from a file for plan/PRD generation" },
    { label: "--prompt -", desc: "Seed prompt from stdin for plan/PRD generation" },
    { label: "--generate-prd", desc: "Generate a PRD before the plan (plan mode only; default true; set false to skip)" },
    {
      label: "--resume",
      desc: "Resume from saved state (requires existing `.loopy/state.json`); skips git switching",
    },
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
      { label: "--include-last-output", desc: "Include last agent output in prompt (default: false)" },
      { label: "--no-stream", desc: "Disable mirroring agent stdout/stderr to your terminal" },
      { label: "--no-color", desc: "Disable ANSI colors (also respects NO_COLOR)" },
      { label: "--no-emoji", desc: "Disable emoji (use ASCII fallbacks)" },
      { label: "--plain", desc: "Disable color and emoji (plain text output)" },
      { label: "--verbose", desc: "Print full task checklists (default: true; disable with --verbose=false)" },
    ],
    Files: [
      { label: "--plan-file <file>", desc: `Plan doc path (default: ${DEFAULTS.taskFile})` },
      { label: "--prompt-template <file>", desc: "Override prompt template (build or plan)" },
      { label: "--test-command <cmd>", desc: "Test command for phases (required when generating plans)" },
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
      { label: "--guardrail-repeat-limit <n>", desc: "Repeated failure threshold before cooldown (default: 20)" },
      { label: "--guardrail-cooldown-ms <n>", desc: "Extra backoff when guardrail triggers (default: 60000)" },
      { label: "--single-task", desc: "Enforce single-task mode (default: true; disable with --single-task=false)" },
      { label: "--no-bootstrap-agents", desc: "Disable auto-generating .loopy/AGENTS.md" },
    ],
  };

  const lines = [
    "Loopy",
    "",
    "Usage:",
    "  loopy [options]",
    "  loopy status",
    '  loopy hint "<text>"',
    "  loopy reset",
    "  loopy help",
    "  loopy --help, -h",
    "  loopy --version",
    "",
    "Commands:",
    ...formatHelpRows(commands, { indent: "  ", gap: 2 }),
    "",
    "Tip: Plan mode writes the plan and exits. Run `loopy` to start build mode.",
    "",
    "Common options:",
    ...(() => {
      const allAdvanced = Object.values(advancedByGroup).flat();
      const labelWidth = maxStringLength([...commonOptions, ...allAdvanced].map((r) => r.label));
      return formatHelpRows(commonOptions, { indent: "  ", labelWidth, gap: 2 });
    })(),
    "",
    "Advanced options:",
    ...(() => {
      const all = Object.values(advancedByGroup).flat();
      const labelWidth = maxStringLength([...commonOptions, ...all].map((r) => r.label));
      const out = [];
      for (const [group, rows] of Object.entries(advancedByGroup)) {
        out.push("");
        out.push(`${group}:`);
        out.push(...formatHelpRows(rows, { indent: "  ", labelWidth, gap: 2 }));
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
  const planFile = resolveFrom(cwd, flags["plan-file"] || DEFAULTS.taskFile);

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
  state = state || {};

  const planText = await readText(planFile);
  let planMetrics = null;
  if (planText) {
    try {
      const parsed = parseTask(planText);
      const totalTasks = parsed.checklist.length;
      const completedTasks = parsed.checklist.filter((item) => item.checked).length;
      const totalPhases = parsed.phases.length;
      const completedPhases = parsed.phases.reduce((sum, phase) => {
        const section = parsed.phaseSections[phase.id];
        return sum + (section && section.allChecked ? 1 : 0);
      }, 0);
      const currentTaskObj = getCurrentTask(planText, {
        phaseId: (state && state.currentPhase) || "",
      });
      planMetrics = {
        totalTasks,
        completedTasks,
        totalPhases,
        completedPhases,
        currentTask: currentTaskObj ? currentTaskObj.text.trim() : "n/a",
      };
    } catch (_) {
      planMetrics = null;
    }
  }

  const totalDurationMs = (state.iterationDurations || []).reduce((sum, d) => sum + d, 0);
  const startedAt = state.startedAt || "";
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;

  const useColor =
    Boolean(process.stdout && process.stdout.isTTY) &&
    !process.env.NO_COLOR &&
    !flags["no-color"] &&
    !flags.noColor;
  const colorize = (value, color, bold = false) => {
    if (!useColor) return String(value);
    const code = STATUS_ANSI[color] || "";
    const weight = bold ? STATUS_ANSI.bold : "";
    if (!code && !weight) return String(value);
    return `${weight}${code}${value}${STATUS_ANSI.reset}`;
  };
  const formatHeader = (label) => colorize(label, "blue", true);

  const tasksTotal = planMetrics ? planMetrics.totalTasks : 0;
  const tasksDone = planMetrics ? planMetrics.completedTasks : 0;
  const taskPercent = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;
  const barWidth = 20;
  const filled = tasksTotal > 0 ? Math.round((taskPercent / 100) * barWidth) : 0;
  const progressBar = tasksTotal > 0
    ? `[${"#".repeat(filled)}${"-".repeat(Math.max(0, barWidth - filled))}] ${taskPercent}% (${tasksDone}/${tasksTotal})`
    : "[--------------------] n/a";

  const formatLabelLine = (label, value) => `${colorize(label, "cyan")}: ${value}`;
  const formatInfoLine = (label, value) => formatLabelLine(label, value);

  const progressItems = [
    progressBar,
    formatLabelLine("Current phase", (state && state.currentPhase) || "n/a"),
    planMetrics && planMetrics.totalPhases
      ? formatLabelLine("Phases", `${planMetrics.completedPhases}/${planMetrics.totalPhases}`)
      : formatLabelLine("Phases", "n/a"),
    planMetrics
      ? formatLabelLine("Current task", planMetrics.currentTask)
      : formatLabelLine("Current task", "n/a"),
  ];

  const timeItems = [
    totalDurationMs > 0
      ? formatLabelLine("Total duration", formatDurationMs(totalDurationMs))
      : formatLabelLine("Total duration", "n/a"),
    elapsedMs > 0
      ? formatLabelLine("Elapsed", formatDurationMs(elapsedMs))
      : formatLabelLine("Elapsed", "n/a"),
    startedAt ? formatLabelLine("Started at", startedAt) : formatLabelLine("Started at", "n/a"),
    formatLabelLine("Updated at", (state && state.updatedAt) || "n/a"),
  ];
  const infoItems = [
    formatInfoLine("Iteration", state && state.iteration != null ? state.iteration : 0),
    formatInfoLine("Last status", (state && state.lastStatus) || "n/a"),
    formatInfoLine("Last test", (state && state.lastTest) || "n/a"),
    formatInfoLine("Last error", (state && state.lastError) || "n/a"),
    formatInfoLine("Last hint", (state && state.lastHint) || "n/a"),
    formatInfoLine("Last hint at", (state && state.lastHintAt) || "n/a"),
    formatInfoLine("Hint count", state && state.hintCount != null ? state.hintCount : 0),
    formatInfoLine("Last bytes", state && state.lastBytes != null ? state.lastBytes : 0),
    formatInfoLine("Plan file", path.relative(cwd, planFile) || planFile),
    formatInfoLine("Hints file", path.relative(cwd, hintsFile) || hintsFile),
  ];

  const indentLines = (items) => items.map((line) => (line ? `  - ${line}` : ""));
  const progressLines = [formatHeader("📈 Progress"), ...indentLines(progressItems)];
  const timeLines = [formatHeader("⏱️ Time"), ...indentLines(timeItems)];
  const infoLines = [formatHeader("ℹ️ Details"), ...indentLines(infoItems)];

  const lines = [
    `Loopy status (${path.relative(cwd, stateFile) || stateFile})`,
    "",
    ...progressLines,
    "",
    ...timeLines,
    "",
    ...infoLines,
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

async function runReset(flags) {
  const cwd = process.cwd();
  const loopyDir = resolveFrom(cwd, DEFAULTS.loopyDir);

  // Check if .loopy directory exists
  try {
    await fs.access(loopyDir);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(`No .loopy directory found at ${path.relative(cwd, loopyDir) || loopyDir}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Create archive directory with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join(loopyDir, "archive", `reset-${timestamp}`);
  await fs.mkdir(archiveDir, { recursive: true });

  // Move all files except archive directory
  const entries = await fs.readdir(loopyDir);
  const moved = [];
  
  for (const entry of entries) {
    if (entry === "archive") continue;
    
    const sourcePath = path.join(loopyDir, entry);
    const destinationPath = path.join(archiveDir, entry);
    
    try {
      await fs.rename(sourcePath, destinationPath);
      moved.push(entry);
    } catch (err) {
      if (err && err.code === "EXDEV") {
        // Cross-device move - copy then delete
        const stat = await fs.stat(sourcePath);
        if (stat.isDirectory()) {
          await fs.cp(sourcePath, destinationPath, { recursive: true });
        } else {
          await fs.copyFile(sourcePath, destinationPath);
        }
        await fs.rm(sourcePath, { recursive: true, force: true });
        moved.push(entry);
      } else {
        throw err;
      }
    }
  }

  const relArchive = path.relative(cwd, archiveDir) || archiveDir;
  if (moved.length) {
    console.log(`Reset complete. Moved ${moved.length} item(s) to ${relArchive}`);
  } else {
    console.log(`Reset complete. Nothing to archive (already clean).`);
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

  if (command === "reset") {
    await runReset(flags);
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

  const stopSignal = createStopSignal();
  let currentActivityLog = DEFAULTS.activityLog;

  const handleStop = async (signalName) => {
    if (stopSignal.stopRequested) return;
    stopSignal.requestStop(signalName);
    printStep(`Signal ${signalName} received; stopping`, { level: "warn" });
    try {
      await appendActivity(currentActivityLog, [`${signalName} received. Stopping.`]);
    } catch (_) {
      // ignore
    }
  };

  process.on("SIGINT", () => {
    void handleStop("SIGINT");
  });

  process.on("SIGTERM", () => {
    void handleStop("SIGTERM");
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
