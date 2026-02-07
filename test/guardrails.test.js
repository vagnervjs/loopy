const { suite } = require("./suite");
const test = suite("guardrails");
const assert = require("node:assert/strict");

const { detectThrash, detectRepeatFailure } = require("../src/guardrails");

// ── detectThrash ───────────────────────────────────────────────────────

test("detectThrash - no thrash when files list is empty", () => {
  const state = { lastFileSignature: "a.js", lastStatus: "failure", fileThrashCount: 2 };
  const result = detectThrash(state, []);
  assert.equal(result.thrash, false);
  // State should be returned unchanged
  assert.deepStrictEqual(result.state, state);
});

test("detectThrash - no thrash when files list is null", () => {
  const state = {};
  const result = detectThrash(state, null);
  assert.equal(result.thrash, false);
});

test("detectThrash - no thrash on first failure with files", () => {
  const state = {};
  const result = detectThrash(state, ["a.js", "b.js"]);
  assert.equal(result.thrash, false);
  assert.equal(result.state.fileThrashCount, 1);
  assert.equal(result.state.lastFileSignature, "a.js,b.js");
});

test("detectThrash - increments count on consecutive same-file failures", () => {
  const state = {
    lastFileSignature: "a.js,b.js",
    lastStatus: "failure",
    fileThrashCount: 1,
  };
  const result = detectThrash(state, ["b.js", "a.js"]); // order shouldn't matter (sorted)
  assert.equal(result.thrash, false);
  assert.equal(result.state.fileThrashCount, 2);
});

test("detectThrash - triggers thrash at count >= 3", () => {
  const state = {
    lastFileSignature: "a.js,b.js",
    lastStatus: "failure",
    fileThrashCount: 2,
  };
  const result = detectThrash(state, ["a.js", "b.js"]);
  assert.equal(result.thrash, true);
  assert.equal(result.state.fileThrashCount, 3);
});

test("detectThrash - resets count when file signature changes", () => {
  const state = {
    lastFileSignature: "a.js,b.js",
    lastStatus: "failure",
    fileThrashCount: 2,
  };
  const result = detectThrash(state, ["c.js"]);
  assert.equal(result.thrash, false);
  assert.equal(result.state.fileThrashCount, 1);
  assert.equal(result.state.lastFileSignature, "c.js");
});

test("detectThrash - resets count when last status was not failure", () => {
  const state = {
    lastFileSignature: "a.js,b.js",
    lastStatus: "success",
    fileThrashCount: 2,
  };
  const result = detectThrash(state, ["a.js", "b.js"]);
  assert.equal(result.thrash, false);
  assert.equal(result.state.fileThrashCount, 1);
});

test("detectThrash - does not mutate original state", () => {
  const state = { lastFileSignature: "a.js", lastStatus: "failure", fileThrashCount: 1 };
  const original = { ...state };
  detectThrash(state, ["a.js"]);
  assert.deepStrictEqual(state, original);
});

// ── detectRepeatFailure ────────────────────────────────────────────────

test("detectRepeatFailure - no repeat when errorSignature is empty", () => {
  const state = {};
  const result = detectRepeatFailure(state, "");
  assert.equal(result.repeated, false);
});

test("detectRepeatFailure - no repeat when errorSignature is null", () => {
  const state = {};
  const result = detectRepeatFailure(state, null);
  assert.equal(result.repeated, false);
});

test("detectRepeatFailure - counts first occurrence", () => {
  const state = {};
  const result = detectRepeatFailure(state, "test::fail");
  assert.equal(result.repeated, false);
  assert.equal(result.state.errorCounts["test::fail"], 1);
});

test("detectRepeatFailure - increments count for same signature", () => {
  const state = { errorCounts: { "test::fail": 1 } };
  const result = detectRepeatFailure(state, "test::fail");
  assert.equal(result.repeated, false);
  assert.equal(result.state.errorCounts["test::fail"], 2);
});

test("detectRepeatFailure - triggers repeated at default limit (3)", () => {
  const state = { errorCounts: { "test::fail": 2 } };
  const result = detectRepeatFailure(state, "test::fail");
  assert.equal(result.repeated, true);
  assert.equal(result.state.errorCounts["test::fail"], 3);
});

test("detectRepeatFailure - respects custom limit", () => {
  // With count at 3, incrementing to 4 is still below limit 5.
  const state = { errorCounts: { "test::fail": 3 } };
  const result = detectRepeatFailure(state, "test::fail", 5);
  assert.equal(result.repeated, false);
  assert.equal(result.state.errorCounts["test::fail"], 4);

  // Incrementing to 5 hits the limit (>= 5).
  const result2 = detectRepeatFailure(result.state, "test::fail", 5);
  assert.equal(result2.repeated, true);
  assert.equal(result2.state.errorCounts["test::fail"], 5);
});

test("detectRepeatFailure - tracks different signatures independently", () => {
  const state = { errorCounts: { "test::fail": 2 } };
  const result = detectRepeatFailure(state, "lint::error");
  assert.equal(result.repeated, false);
  assert.equal(result.state.errorCounts["lint::error"], 1);
  assert.equal(result.state.errorCounts["test::fail"], 2);
});

test("detectRepeatFailure - does not mutate original state", () => {
  const state = { errorCounts: { "test::fail": 1 } };
  const original = JSON.parse(JSON.stringify(state));
  detectRepeatFailure(state, "test::fail");
  assert.deepStrictEqual(state, original);
});

test("detectRepeatFailure - does not mutate original errorCounts object", () => {
  const errorCounts = { "test::fail": 1 };
  const state = { errorCounts };
  const result = detectRepeatFailure(state, "test::fail");
  // The result should have a new errorCounts object
  assert.notStrictEqual(result.state.errorCounts, errorCounts);
  // Original should be unchanged
  assert.equal(errorCounts["test::fail"], 1);
});
