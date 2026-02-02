const { suite } = require("./suite");
const test = suite("steps-format");
const assert = require("node:assert/strict");

const { configureSteps, printStep } = require("../src/steps");

test("wraps long log lines and aligns continuation", () => {
  const originalWrite = process.stdout.write;
  const originalColumns = process.stdout.columns;
  let output = "";

  const writeCapture = (chunk) => {
    output += String(chunk || "");
    return true;
  };

  try {
    Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
    process.stdout.write = writeCapture;
    configureSteps({ plain: true });

    printStep(
      "Wrap this line so it spans multiple lines for alignment testing across the prefix boundary.",
      { kind: "meta" }
    );
  } finally {
    process.stdout.write = originalWrite;
    if (Object.prototype.hasOwnProperty.call(process.stdout, "columns")) {
      if (originalColumns === undefined) {
        delete process.stdout.columns;
      } else {
        Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
      }
    }
    configureSteps({ plain: false, noColor: false, noEmoji: false });
  }

  const lines = output.trimEnd().split(/\r?\n/);
  assert.ok(lines.length > 1, "expected wrapped output");

  const prefixMatch = lines[0].match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+.. /);
  assert.ok(prefixMatch, "expected timestamp + icon prefix");
  const prefixLen = prefixMatch[0].length;
  assert.ok(lines[1].startsWith(" ".repeat(prefixLen)));
});
