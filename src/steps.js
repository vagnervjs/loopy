function printStep(message, { iteration } = {}) {
  const iterPrefix = iteration != null ? `iter ${iteration}: ` : "";
  process.stdout.write(`[loopy] ${iterPrefix}${message}\n`);
}

module.exports = {
  printStep,
};

