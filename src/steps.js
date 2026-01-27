function printStep(message, { iteration, level } = {}) {
  const iterPrefix = iteration != null ? `iter ${iteration}: ` : "";
  const levelLabel = level ? String(level).toLowerCase() : "info";
  const text = message == null ? "" : String(message);
  process.stdout.write(`[loopy] [${levelLabel}] ${iterPrefix}${text}\n`);
}

module.exports = {
  printStep,
};

