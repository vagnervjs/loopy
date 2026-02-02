const assert = require("node:assert/strict");
const test = require("node:test");

const { extractRequiredTests } = require("../src/task");

test("extractRequiredTests - returns empty when missing", () => {
  assert.equal(extractRequiredTests("Implement foo"), "");
});

test("extractRequiredTests - parses required tests value", () => {
  const text = "Implement: foo — Acceptance: works — Required tests: npm test";
  assert.equal(extractRequiredTests(text), "npm test");
});

test("extractRequiredTests - trims trailing punctuation", () => {
  const text = "Fix: bar — Acceptance: ok — Required tests: pnpm test.";
  assert.equal(extractRequiredTests(text), "pnpm test");
});

test("extractRequiredTests - ignores none/n-a values", () => {
  const text = "Docs: update readme — Acceptance: updated — Required tests: none";
  assert.equal(extractRequiredTests(text), "");
  const text2 = "Docs: update readme — Acceptance: updated — Required tests: N/A";
  assert.equal(extractRequiredTests(text2), "");
});
