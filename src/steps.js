const { formatLocalTimestamp } = require("./text");

let hasWritten = false;
let lastLineBlank = false;
let activeIteration = null;
let activeIterationStartMs = null;

const LEVEL_LABEL_WIDTH = 5;
const MIN_WRAP_WIDTH = 80;
const MAX_WRAP_WIDTH = 120;
const DEFAULT_WRAP_WIDTH = 100;

function formatLevelLabel(level) {
  const label = level ? String(level).toLowerCase() : "info";
  return label.padEnd(LEVEL_LABEL_WIDTH, " ");
}

function getWrapWidth() {
  const columns = Number(process.stdout && process.stdout.columns);
  if (Number.isFinite(columns) && columns > 0) {
    return Math.min(MAX_WRAP_WIDTH, Math.max(MIN_WRAP_WIDTH, columns));
  }
  return DEFAULT_WRAP_WIDTH;
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

function wrapWithPrefix(prefix, message) {
  const text = message == null ? "" : String(message);
  const words = text.trim() ? text.trim().split(/\s+/) : [];
  if (!words.length) return prefix.trimEnd();
  const maxWidth = getWrapWidth();
  const available = Math.max(10, maxWidth - prefix.length);
  const lines = wrapWords(words, available);
  const indent = " ".repeat(prefix.length);
  return lines.map((line, index) => (index === 0 ? prefix + line : indent + line)).join("\n");
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return "";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (totalMinutes > 0) return `${totalMinutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatStepLine(message, { iteration, level } = {}) {
  const iterPrefix = iteration != null ? `iter ${iteration}: ` : "";
  const levelLabel = formatLevelLabel(level);
  const text = message == null ? "" : String(message);
  const prefix = `[loopy] [${levelLabel}] ${iterPrefix}`;
  return wrapWithPrefix(prefix, text);
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

function startIteration({ iteration, phase, startedAt } = {}) {
  if (iteration == null) return;
  if (activeIteration === iteration) return;
  const startDate = startedAt instanceof Date ? startedAt : new Date(startedAt || Date.now());
  const startMs = Number.isFinite(startDate.getTime()) ? startDate.getTime() : Date.now();
  const startLabel = formatLocalTimestamp(startDate) || "n/a";
  const phaseLabel = String(phase || "").trim() || "n/a";
  activeIteration = iteration;
  activeIterationStartMs = startMs;
  ensureBlankLine();
  writeLine(formatStepLine(`iteration (phase: ${phaseLabel}, start: ${startLabel})`, { iteration }));
}

function endIteration({ iteration, endedAt } = {}) {
  if (activeIteration == null) return;
  if (iteration != null && iteration !== activeIteration) return;
  const endDate = endedAt instanceof Date ? endedAt : new Date(endedAt || Date.now());
  const endMs = Number.isFinite(endDate.getTime()) ? endDate.getTime() : Date.now();
  if (Number.isFinite(activeIterationStartMs)) {
    const duration = formatDurationMs(Math.max(0, endMs - activeIterationStartMs));
    if (duration) {
      writeLine(formatStepLine(`duration ${duration}`, { iteration: activeIteration }));
    }
  }
  ensureBlankLine();
  activeIteration = null;
  activeIterationStartMs = null;
}

function printStep(message, options = {}) {
  writeLine(formatStepLine(message, options));
}

module.exports = {
  endIteration,
  printStep,
  startIteration,
};

