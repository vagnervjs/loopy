const { suite } = require("./suite");
const test = suite("baseline");
const assert = require("node:assert/strict");

const {
  extractFailureSignatures,
  diffFailures,
  checkRelatedness,
  loadCachedBaseline,
  buildBaselineResult,
  evaluateTestFailure,
} = require("../src/baseline");

// ── extractFailureSignatures ────────────────────────────────────────────

test("extractFailureSignatures - returns empty array for empty input", () => {
  assert.deepStrictEqual(extractFailureSignatures(""), []);
  assert.deepStrictEqual(extractFailureSignatures(null), []);
  assert.deepStrictEqual(extractFailureSignatures(undefined), []);
});

test("extractFailureSignatures - extracts Jest FAIL lines", () => {
  const output = [
    "FAIL packages/core/src/__tests__/core.test.js",
    "FAIL packages/utils/src/__tests__/utils.test.js",
    "PASS packages/api/src/__tests__/api.test.js",
  ].join("\n");
  const sigs = extractFailureSignatures(output);
  assert.ok(sigs.includes("FAIL:packages/core/src/__tests__/core.test.js"));
  assert.ok(sigs.includes("FAIL:packages/utils/src/__tests__/utils.test.js"));
  assert.equal(sigs.length, 2);
});

test("extractFailureSignatures - extracts Jest suite failures (bullet)", () => {
  const output = "● AuthService > should authenticate user\n● AuthService > should reject bad token";
  const sigs = extractFailureSignatures(output);
  assert.ok(sigs.includes("TEST:AuthService > should authenticate user"));
  assert.ok(sigs.includes("TEST:AuthService > should reject bad token"));
});

test("extractFailureSignatures - extracts cross-mark test failures", () => {
  const output = "✕ should handle edge case\n✓ should work normally";
  const sigs = extractFailureSignatures(output);
  assert.ok(sigs.includes("TEST:should handle edge case"));
  assert.equal(sigs.length, 1);
});

test("extractFailureSignatures - extracts Node.js test runner failures", () => {
  const output = "✖ should fail gracefully\nnot ok 3 - my test case";
  const sigs = extractFailureSignatures(output);
  assert.ok(sigs.includes("TEST:should fail gracefully"));
  assert.ok(sigs.includes("TEST:my test case"));
});

test("extractFailureSignatures - extracts error patterns", () => {
  const output = "TypeError: Cannot read properties of undefined (reading 'foo')\nReferenceError: bar is not defined";
  const sigs = extractFailureSignatures(output);
  assert.ok(sigs.some((s) => s.startsWith("ERR:TypeError:")));
  assert.ok(sigs.some((s) => s.startsWith("ERR:ReferenceError:")));
});

test("extractFailureSignatures - deduplicates identical lines", () => {
  const output = "FAIL packages/core/test.js\nFAIL packages/core/test.js\nFAIL packages/core/test.js";
  const sigs = extractFailureSignatures(output);
  assert.equal(sigs.length, 1);
});

test("extractFailureSignatures - returns sorted results", () => {
  const output = "FAIL z-package/test.js\nFAIL a-package/test.js\nFAIL m-package/test.js";
  const sigs = extractFailureSignatures(output);
  const sorted = [...sigs].sort();
  assert.deepStrictEqual(sigs, sorted);
});

// ── diffFailures ────────────────────────────────────────────────────────

test("diffFailures - identical failures", () => {
  const base = ["FAIL:a.test.js", "FAIL:b.test.js"];
  const curr = ["FAIL:a.test.js", "FAIL:b.test.js"];
  const result = diffFailures(base, curr);
  assert.equal(result.status, "identical");
  assert.equal(result.newFailures.length, 0);
  assert.equal(result.resolvedFailures.length, 0);
});

test("diffFailures - improved (fewer failures)", () => {
  const base = ["FAIL:a.test.js", "FAIL:b.test.js", "FAIL:c.test.js"];
  const curr = ["FAIL:a.test.js"];
  const result = diffFailures(base, curr);
  assert.equal(result.status, "improved");
  assert.equal(result.newFailures.length, 0);
  assert.equal(result.resolvedFailures.length, 2);
});

test("diffFailures - subset (current is subset of baseline)", () => {
  const base = ["FAIL:a.test.js", "FAIL:b.test.js"];
  const curr = ["FAIL:a.test.js"];
  const result = diffFailures(base, curr);
  // Current has no new failures but resolved some — improved
  assert.equal(result.status, "improved");
});

test("diffFailures - new failures detected", () => {
  const base = ["FAIL:a.test.js"];
  const curr = ["FAIL:a.test.js", "FAIL:new.test.js"];
  const result = diffFailures(base, curr);
  assert.equal(result.status, "new_failures");
  assert.deepStrictEqual(result.newFailures, ["FAIL:new.test.js"]);
});

test("diffFailures - partial overlap (same + new failures)", () => {
  const base = ["FAIL:a.test.js", "FAIL:b.test.js", "FAIL:c.test.js"];
  const curr = ["FAIL:a.test.js", "FAIL:b.test.js", "FAIL:c.test.js", "FAIL:x.test.js", "FAIL:y.test.js"];
  const result = diffFailures(base, curr);
  assert.equal(result.status, "new_failures");
  assert.equal(result.newFailures.length, 2);
  assert.ok(result.newFailures.includes("FAIL:x.test.js"));
  assert.ok(result.newFailures.includes("FAIL:y.test.js"));
});

test("diffFailures - both empty", () => {
  const result = diffFailures([], []);
  assert.equal(result.status, "identical");
});

test("diffFailures - baseline empty, current has failures", () => {
  const result = diffFailures([], ["FAIL:a.test.js"]);
  assert.equal(result.status, "new_failures");
  assert.equal(result.newFailures.length, 1);
});

test("diffFailures - baseline has failures, current empty", () => {
  const result = diffFailures(["FAIL:a.test.js"], []);
  assert.equal(result.status, "improved");
});

// ── checkRelatedness ────────────────────────────────────────────────────

test("checkRelatedness - returns false for empty inputs", () => {
  assert.equal(checkRelatedness([], "some test output"), false);
  assert.equal(checkRelatedness(["a.js"], ""), false);
  assert.equal(checkRelatedness(null, "output"), false);
  assert.equal(checkRelatedness(["a.js"], null), false);
});

test("checkRelatedness - detects full path match", () => {
  const output = "Error in packages/core/jest.config.js at line 12";
  assert.equal(checkRelatedness(["packages/core/jest.config.js"], output), true);
});

test("checkRelatedness - detects basename match", () => {
  const output = "Error loading jest.config.js: invalid syntax";
  assert.equal(checkRelatedness(["packages/core/jest.config.js"], output), true);
});

test("checkRelatedness - detects module name match", () => {
  const output = "Cannot find module 'myComponent'";
  assert.equal(checkRelatedness(["src/myComponent.tsx"], output), true);
});

test("checkRelatedness - returns false when no overlap", () => {
  const output = "FAIL health-journey-common/dist/index.js\nTypeError: dynamic import not supported";
  assert.equal(checkRelatedness(["jest.config.js"], output), false);
});

test("checkRelatedness - skips short module names to avoid false positives", () => {
  // "a" is too short (<=3 chars) to match reliably
  const output = "Error: a test failed with a bad result";
  assert.equal(checkRelatedness(["src/a.js"], output), false);
});

test("checkRelatedness - handles multiple changed files", () => {
  const output = "Error in utils.js at line 5";
  assert.equal(checkRelatedness(["config.js", "src/utils.js"], output), true);
});

// ── loadCachedBaseline ──────────────────────────────────────────────────

test("loadCachedBaseline - returns null when no cached result", () => {
  assert.equal(loadCachedBaseline({}, "abc123", "npm test"), null);
  assert.equal(loadCachedBaseline(null, "abc123", "npm test"), null);
});

test("loadCachedBaseline - returns null when commitSha mismatch", () => {
  const state = {
    baselineTestResult: {
      commitSha: "old-sha",
      testCommand: "npm test",
      exitCode: 1,
      failureSignature: [],
      cachedAt: "2025-01-01T00:00:00Z",
    },
  };
  assert.equal(loadCachedBaseline(state, "new-sha", "npm test"), null);
});

test("loadCachedBaseline - returns null when testCommand mismatch", () => {
  const state = {
    baselineTestResult: {
      commitSha: "abc123",
      testCommand: "npm test",
      exitCode: 1,
      failureSignature: [],
      cachedAt: "2025-01-01T00:00:00Z",
    },
  };
  assert.equal(loadCachedBaseline(state, "abc123", "npm run test-all"), null);
});

test("loadCachedBaseline - returns cached result when matching", () => {
  const cached = {
    commitSha: "abc123",
    testCommand: "npm test",
    exitCode: 1,
    failureSignature: ["FAIL:a.test.js"],
    cachedAt: "2025-01-01T00:00:00Z",
  };
  const state = { baselineTestResult: cached };
  const result = loadCachedBaseline(state, "abc123", "npm test");
  assert.deepStrictEqual(result, cached);
});

// ── buildBaselineResult ─────────────────────────────────────────────────

test("buildBaselineResult - creates proper structure", () => {
  const result = buildBaselineResult("abc123", "npm test", 1, ["FAIL:a.test.js"]);
  assert.equal(result.commitSha, "abc123");
  assert.equal(result.testCommand, "npm test");
  assert.equal(result.exitCode, 1);
  assert.deepStrictEqual(result.failureSignature, ["FAIL:a.test.js"]);
  assert.ok(result.cachedAt);
});

test("buildBaselineResult - handles null failureSignature", () => {
  const result = buildBaselineResult("abc123", "npm test", 0, null);
  assert.deepStrictEqual(result.failureSignature, []);
});

// ── evaluateTestFailure ─────────────────────────────────────────────────

test("evaluateTestFailure - Tier 1: allows fix attempt when failures are related", async () => {
  const config = { fixBudget: 1, cwd: "/tmp" };
  const state = {};
  const result = await evaluateTestFailure(config, state, {
    testOutput: "Error in jest.config.js at line 5\nTypeError: invalid config",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["jest.config.js"],
  });
  assert.equal(result.action, "fix_attempt");
  assert.equal(result.stateUpdates.baselineFixAttempts, 1);
});

test("evaluateTestFailure - Tier 1: skips to Tier 2 when failures are unrelated", async () => {
  const config = { fixBudget: 1, cwd: "/tmp" };
  const state = {};
  const result = await evaluateTestFailure(config, state, {
    testOutput: "FAIL health-journey-common/dist/index.js\nTypeError: dynamic import",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["jest.config.js"],
    getMergeBase: async () => "",
  });
  // Cannot determine merge-base, so falls through to fail
  assert.equal(result.action, "fail");
  assert.ok(result.reason.includes("merge-base"));
});

test("evaluateTestFailure - respects fix budget exhaustion", async () => {
  const config = { fixBudget: 1, cwd: "/tmp" };
  const state = { baselineFixAttempts: 1 };
  const result = await evaluateTestFailure(config, state, {
    testOutput: "Error in jest.config.js\nTypeError: bad",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["jest.config.js"],
    getMergeBase: async () => "",
  });
  // Budget exhausted, goes to tier 2, no merge base
  assert.equal(result.action, "fail");
});

test("evaluateTestFailure - Tier 2: treats identical baseline failures as pass", async () => {
  const config = { fixBudget: 1, cwd: "/tmp" };
  const baseline = {
    commitSha: "abc123",
    testCommand: "npm test",
    exitCode: 1,
    failureSignature: ["FAIL:unrelated/dist/index.js"],
    cachedAt: "2025-01-01T00:00:00Z",
  };
  const state = {
    baselineFixAttempts: 1,
    baselineTestResult: baseline,
  };
  const result = await evaluateTestFailure(config, state, {
    testOutput: "FAIL unrelated/dist/index.js",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["jest.config.js"],
    getMergeBase: async () => "abc123",
  });
  assert.equal(result.action, "pass");
  assert.ok(result.reason.includes("pre-existing"));
});

test("evaluateTestFailure - Tier 2: detects new failures not in baseline", async () => {
  const config = { fixBudget: 0, cwd: "/tmp" };
  const baseline = {
    commitSha: "abc123",
    testCommand: "npm test",
    exitCode: 1,
    failureSignature: ["FAIL:old.test.js"],
    cachedAt: "2025-01-01T00:00:00Z",
  };
  const state = {
    baselineTestResult: baseline,
  };
  const result = await evaluateTestFailure(config, state, {
    testOutput: "FAIL old.test.js\nFAIL new.test.js",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["src/app.js"],
    getMergeBase: async () => "abc123",
  });
  assert.equal(result.action, "fail");
  assert.ok(result.newFailures.includes("FAIL:new.test.js"));
});

test("evaluateTestFailure - Tier 2: treats improved results as pass", async () => {
  const config = { fixBudget: 0, cwd: "/tmp" };
  const baseline = {
    commitSha: "abc123",
    testCommand: "npm test",
    exitCode: 1,
    failureSignature: ["FAIL:a.test.js", "FAIL:b.test.js"],
    cachedAt: "2025-01-01T00:00:00Z",
  };
  const state = { baselineTestResult: baseline };
  const result = await evaluateTestFailure(config, state, {
    testOutput: "FAIL a.test.js",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["src/app.js"],
    getMergeBase: async () => "abc123",
  });
  assert.equal(result.action, "pass");
  assert.ok(result.reason.includes("improved") || result.reason.includes("fewer"));
});

test("evaluateTestFailure - fix_budget 0 skips Tier 1 entirely", async () => {
  const config = { fixBudget: 0, cwd: "/tmp" };
  const state = {};
  const result = await evaluateTestFailure(config, state, {
    testOutput: "Error in jest.config.js\nTypeError: bad config",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["jest.config.js"],
    getMergeBase: async () => "",
  });
  // Even though related, fix_budget=0 means no fix attempts
  assert.notEqual(result.action, "fix_attempt");
});

test("evaluateTestFailure - new failures with budget remaining get fix attempt via Tier 2", async () => {
  const config = { fixBudget: 1, cwd: "/tmp" };
  const baseline = {
    commitSha: "abc123",
    testCommand: "npm test",
    exitCode: 1,
    failureSignature: ["FAIL:old.test.js"],
    cachedAt: "2025-01-01T00:00:00Z",
  };
  const state = {
    baselineFixAttempts: 0,
    baselineTestResult: baseline,
  };
  // Unrelated changed files so Tier 1 is skipped
  const result = await evaluateTestFailure(config, state, {
    testOutput: "FAIL old.test.js\nFAIL brand-new.test.js",
    testExitCode: 1,
    testCommand: "npm test",
    changedFiles: ["something-unrelated.txt"],
    getMergeBase: async () => "abc123",
  });
  assert.equal(result.action, "fix_attempt");
  assert.ok(result.newFailures.includes("FAIL:brand-new.test.js"));
});
