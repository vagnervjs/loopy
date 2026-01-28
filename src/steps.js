const { formatLocalTimestamp } = require("./text");

let hasWritten = false;
let lastLineBlank = false;
let activeIteration = null;
let activeIterationStartMs = null;

const MIN_WRAP_WIDTH = 80;
const MAX_WRAP_WIDTH = 120;
const DEFAULT_WRAP_WIDTH = 100;
const ICON_WIDTH = 2;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const ICONS = {
  default: { emoji: "•", ascii: "-" },
  meta: { emoji: "•", ascii: "-" },
  "loop-start": { emoji: "🚀", ascii: ">>" },
  "loop-stop": { emoji: "🏁", ascii: "ok" },
  branch: { emoji: "🌿", ascii: "br" },
  plan: { emoji: "📋", ascii: "pl" },
  "plan-item": { emoji: "▸", ascii: ">" },
  "iteration-start": { emoji: "🔁", ascii: "it" },
  "iteration-complete": { emoji: "✅", ascii: "ok" },
  prompt: { emoji: "💬", ascii: "pm" },
  agent: { emoji: "🤖", ascii: "ag" },
  tasks: { emoji: "✅", ascii: "ok" },
  tests: { emoji: "🧪", ascii: "ts" },
  git: { emoji: "🧩", ascii: "gt" },
  archive: { emoji: "📦", ascii: "ar" },
  hook: { emoji: "🪝", ascii: "hk" },
  state: { emoji: "🗂️", ascii: "st" },
  guardrail: { emoji: "🛑", ascii: "!!" },
  warn: { emoji: "⚠️", ascii: "!!" },
  error: { emoji: "❌", ascii: "xx" },
  sleep: { emoji: "⏳", ascii: "zz" },
  resume: { emoji: "↩️", ascii: "rs" },
  result: { emoji: "📌", ascii: "rs" },
};

const TONE_STYLES = {
  header: ["cyan", "bold"],
  success: ["green"],
  warn: ["yellow"],
  error: ["red"],
  meta: ["gray"],
  info: [],
};

const KIND_TONES = {
  "loop-start": "header",
  "loop-stop": "success",
  branch: "header",
  plan: "header",
  meta: "meta",
  "iteration-start": "header",
  "iteration-complete": "success",
  archive: "success",
  guardrail: "warn",
  sleep: "meta",
  state: "meta",
  result: "meta",
  resume: "meta",
};

const STEP_CONFIG = {
  noColor: false,
  noEmoji: false,
};

function configureSteps(options = {}) {
  const plain = Boolean(options.plain);
  STEP_CONFIG.noColor = plain ? true : Boolean(options.noColor);
  STEP_CONFIG.noEmoji = plain ? true : Boolean(options.noEmoji);
}

function getWrapWidth() {
  const columns = Number(process.stdout && process.stdout.columns);
  if (Number.isFinite(columns) && columns > 0) {
    return Math.min(MAX_WRAP_WIDTH, Math.max(MIN_WRAP_WIDTH, columns));
  }
  return DEFAULT_WRAP_WIDTH;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(value) {
  return Array.from(stripAnsi(value)).length;
}

function wrapWords(words, maxWidth) {
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxWidth) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function applyStyle(text, styles) {
  if (STEP_CONFIG.noColor || !styles || !styles.length) return text;
  const codes = styles.map((style) => ANSI[style]).filter(Boolean).join("");
  if (!codes) return text;
  return `${codes}${text}${ANSI.reset}`;
}

function resolveIcon({ icon, kind, level } = {}) {
  if (icon) return icon;
  if (level === "error") return ICONS.error;
  if (level === "warn") return ICONS.warn;
  return ICONS[kind] || ICONS.default;
}

function formatIcon(spec) {
  if (!spec) return " ".repeat(ICON_WIDTH);
  if (typeof spec === "string") {
    if (STEP_CONFIG.noEmoji) return spec.padEnd(ICON_WIDTH, " ").slice(0, ICON_WIDTH);
    return spec;
  }
  const chosen = STEP_CONFIG.noEmoji ? spec.ascii || spec.emoji : spec.emoji || spec.ascii;
  if (!chosen) return " ".repeat(ICON_WIDTH);
  if (STEP_CONFIG.noEmoji) return String(chosen).padEnd(ICON_WIDTH, " ").slice(0, ICON_WIDTH);
  return String(chosen);
}

function resolveTone({ kind, level } = {}) {
  if (level === "success") return "success";
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  return KIND_TONES[kind] || "info";
}

function normalizeIndent(options = {}) {
  if (options.indent != null) {
    const spaces = Number(options.indent);
    if (Number.isFinite(spaces) && spaces > 0) return " ".repeat(spaces);
    if (spaces === 0) return "";
  }
  if (options.iteration != null && !options.isHeader && !options.isFooter) {
    return "  ";
  }
  return "";
}

function formatStepLine(message, options = {}) {
  const timestampValue = options.timestamp || new Date();
  const timestamp = formatLocalTimestamp(timestampValue) || "n/a";
  const iconSpec = resolveIcon(options);
  const iconText = formatIcon(iconSpec);
  const indentText = normalizeIndent(options);
  const tone = resolveTone(options);
  const styles = TONE_STYLES[tone] || TONE_STYLES.info;

  const text = message == null ? "" : String(message);
  const words = text.trim() ? text.trim().split(/\s+/) : [];
  const prefixPlain = `${timestamp}  ${indentText}${iconText} `;
  const prefixLen = visibleLength(prefixPlain);
  if (!words.length) return prefixPlain.trimEnd();

  const maxWidth = getWrapWidth();
  const available = Math.max(10, maxWidth - prefixLen);
  const lines = wrapWords(words, available);
  const indent = " ".repeat(prefixLen);
  const styledTimestamp = applyStyle(timestamp, ["dim"]);
  const firstContent = `${indentText}${iconText} ${lines[0]}`;
  let output = `${styledTimestamp}  ${applyStyle(firstContent, styles)}`;
  for (let i = 1; i < lines.length; i += 1) {
    output += `\n${indent}${applyStyle(lines[i], styles)}`;
  }
  return output;
}

function writeLine(line) {
  const output = line == null ? "" : String(line);
  process.stdout.write(`${output}\n`);
  hasWritten = true;
  lastLineBlank = !output.trim();
}

function ensureBlankLine() {
  if (!hasWritten || lastLineBlank) return;
  process.stdout.write("\n");
  hasWritten = true;
  lastLineBlank = true;
}

function printBlankLine() {
  ensureBlankLine();
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return "";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${totalMinutes}m ${seconds}s`;
}

function startIteration({ iteration, phase, startedAt } = {}) {
  if (iteration == null) return;
  if (activeIteration === iteration) return;
  const startDate = startedAt instanceof Date ? startedAt : new Date(startedAt || Date.now());
  const startMs = Number.isFinite(startDate.getTime()) ? startDate.getTime() : Date.now();
  const phaseLabel = String(phase || "").trim();
  activeIteration = iteration;
  activeIterationStartMs = startMs;
  ensureBlankLine();
  const suffix = phaseLabel ? ` · ${phaseLabel}` : "";
  writeLine(
    formatStepLine(`Iteration ${iteration} start${suffix}`, {
      iteration,
      isHeader: true,
      kind: "iteration-start",
      timestamp: startDate,
    })
  );
}

function endIteration({ iteration, endedAt, status } = {}) {
  if (activeIteration == null) return;
  if (iteration != null && iteration !== activeIteration) return;
  const endDate = endedAt instanceof Date ? endedAt : new Date(endedAt || Date.now());
  const endMs = Number.isFinite(endDate.getTime()) ? endDate.getTime() : Date.now();
  let durationLabel = "";
  if (Number.isFinite(activeIterationStartMs)) {
    const duration = formatDurationMs(Math.max(0, endMs - activeIterationStartMs));
    if (duration) durationLabel = ` · Duration ${duration}`;
  }
  writeLine(
    formatStepLine(`Iteration ${activeIteration} complete${durationLabel}`, {
      iteration: activeIteration,
      isFooter: true,
      kind: "iteration-complete",
      level: status === "failure" ? "error" : undefined,
      timestamp: endDate,
    })
  );
  ensureBlankLine();
  activeIteration = null;
  activeIterationStartMs = null;
}

function printStep(message, options = {}) {
  writeLine(formatStepLine(message, options));
}

module.exports = {
  configureSteps,
  endIteration,
  printBlankLine,
  printStep,
  startIteration,
};

