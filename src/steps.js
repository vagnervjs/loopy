let hasWritten = false;
let lastLineBlank = false;
let activeIteration = null;
let activeIterationStartMs = null;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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
  const levelLabel = level ? String(level).toLowerCase() : "info";
  const text = message == null ? "" : String(message);
  return `[loopy] [${levelLabel}] ${iterPrefix}${text}`;
}

function writeLine(line) {
  process.stdout.write(`${line}\n`);
  hasWritten = true;
  lastLineBlank = false;
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

