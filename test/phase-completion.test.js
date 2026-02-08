const { suite } = require("./suite");
const test = suite("phase-completion");
const assert = require("node:assert/strict");

const { isPhaseComplete, isPhaseAllChecked, areAllPhasesComplete, pickCurrentPhaseId, phaseHasTestCommand } = require("../src/loop/phases");
const { parseTask } = require("../src/task");

// ---------------------------------------------------------------------------
// areAllPhasesComplete — unit tests
// ---------------------------------------------------------------------------

test("areAllPhasesComplete: no phases defined → returns true", () => {
  const parsed = parseTask("- [x] Task 1\n- [x] Task 2\n");
  assert.equal(areAllPhasesComplete(parsed, {}), true);
});

test("areAllPhasesComplete: all boxes checked + all phases stop_on all_checked → complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "    stop_on: all_checked",
    "  - id: test",
    "    stop_on: all_checked",
    "---",
    "",
    "<!-- loopy:phase build -->",
    "- [x] Build step 1",
    "- [x] Build step 2",
    "",
    "<!-- loopy:phase test -->",
    "- [x] Test step 1",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(areAllPhasesComplete(parsed, {}), true);
});

test("areAllPhasesComplete: all boxes checked + tests failing + phase has test_command → NOT complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "  - id: validate",
    "    test_command: npm test",
    "---",
    "",
    "<!-- loopy:phase build -->",
    "- [x] Build step 1",
    "",
    "<!-- loopy:phase validate -->",
    "- [x] Validate step 1",
    "",
  ].join("\n");
  const parsed = parseTask(text);

  // Tests failing — state has lastTest: "fail ..."
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(areAllPhasesComplete(parsed, state), false);
});

test("areAllPhasesComplete: all boxes checked + tests passing + phase has test_command → complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "  - id: validate",
    "    test_command: npm test",
    "---",
    "",
    "<!-- loopy:phase build -->",
    "- [x] Build step 1",
    "",
    "<!-- loopy:phase validate -->",
    "- [x] Validate step 1",
    "",
  ].join("\n");
  const parsed = parseTask(text);

  // Tests passing — state has lastTest: "pass ..."
  const state = { lastTest: "pass @ 2026-02-06T12:00:00" };
  assert.equal(areAllPhasesComplete(parsed, state), true);
});

test("areAllPhasesComplete: respects testStatus override over state.lastTest", () => {
  const text = [
    "---",
    "phases:",
    "  - id: impl",
    "    test_command: npm test",
    "---",
    "",
    "<!-- loopy:phase impl -->",
    "- [x] Implement feature",
    "",
  ].join("\n");
  const parsed = parseTask(text);

  // State says pass but current iteration testStatus says fail
  const state = { lastTest: "pass @ old" };
  assert.equal(areAllPhasesComplete(parsed, state, { testStatus: "fail @ 2026-02-06T12:00:00" }), false);

  // testStatus says pass
  assert.equal(areAllPhasesComplete(parsed, state, { testStatus: "pass @ 2026-02-06T12:00:00" }), true);
});

test("areAllPhasesComplete: one phase incomplete (unchecked box) → NOT complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: phase-a",
    "    stop_on: all_checked",
    "  - id: phase-b",
    "    stop_on: all_checked",
    "---",
    "",
    "<!-- loopy:phase phase-a -->",
    "- [x] Done",
    "",
    "<!-- loopy:phase phase-b -->",
    "- [ ] Not done yet",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(areAllPhasesComplete(parsed, {}), false);
});

test("areAllPhasesComplete: all boxes checked + tests failing + no phase has test_command → complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: alpha",
    "  - id: beta",
    "---",
    "",
    "<!-- loopy:phase alpha -->",
    "- [x] Alpha task",
    "",
    "<!-- loopy:phase beta -->",
    "- [x] Beta task",
    "",
  ].join("\n");
  const parsed = parseTask(text);

  // Tests failing, but no phase has a test_command — should still be complete (Gate 2 not applicable)
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(areAllPhasesComplete(parsed, state), true);
});

// ---------------------------------------------------------------------------
// Early-exit path: allChecked + phase requires tests_pass + last test failed
// ---------------------------------------------------------------------------

test("early exit: allChecked true but state.lastTest is fail with test_command phase → areAllPhasesComplete returns false", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build-modules",
    "    test_command: npm run test-modules",
    "---",
    "",
    "<!-- loopy:phase build-modules -->",
    "- [x] Module A",
    "- [x] Module B",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(parsed.allChecked, true, "allChecked should be true");

  // State reflects that tests failed in a previous iteration
  const state = { lastTest: "fail @ 2026-02-06T10:00:00" };
  assert.equal(
    areAllPhasesComplete(parsed, state),
    false,
    "Should NOT be complete when phase has test_command and lastTest is fail"
  );
});

test("early exit: allChecked true + state.lastTest is pass with test_command phase → areAllPhasesComplete returns true", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build-modules",
    "    test_command: npm run test-modules",
    "---",
    "",
    "<!-- loopy:phase build-modules -->",
    "- [x] Module A",
    "- [x] Module B",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(parsed.allChecked, true, "allChecked should be true");

  const state = { lastTest: "pass @ 2026-02-06T10:00:00" };
  assert.equal(
    areAllPhasesComplete(parsed, state),
    true,
    "Should be complete when phase has test_command and lastTest is pass"
  );
});

// ---------------------------------------------------------------------------
// No phases + allChecked → backward compatibility
// ---------------------------------------------------------------------------

test("backward compat: no phases + allChecked → complete regardless of test status", () => {
  const text = "- [x] Task 1\n- [x] Task 2\n";
  const parsed = parseTask(text);
  assert.equal(parsed.allChecked, true);

  // areAllPhasesComplete returns true when no phases defined
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(areAllPhasesComplete(parsed, state), true);
});

// ---------------------------------------------------------------------------
// isPhaseComplete — regression guard
// ---------------------------------------------------------------------------

test("isPhaseComplete: phase with test_command + tests failing → NOT complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: core",
    "    test_command: npm test",
    "---",
    "",
    "<!-- loopy:phase core -->",
    "- [x] Core feature",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(isPhaseComplete(parsed, "core", state), false);
});

test("isPhaseComplete: phase with test_command + tests passing → complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: core",
    "    test_command: npm test",
    "---",
    "",
    "<!-- loopy:phase core -->",
    "- [x] Core feature",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  const state = { lastTest: "pass @ 2026-02-06T12:00:00" };
  assert.equal(isPhaseComplete(parsed, "core", state), true);
});

// ---------------------------------------------------------------------------
// pickCurrentPhaseId — sequence / no wrap-around tests
// ---------------------------------------------------------------------------

test("pickCurrentPhaseId: returns first phase when no state", () => {
  const text = [
    "---",
    "phases:",
    "  - id: plan",
    "    stop_on: all_checked",
    "  - id: implement",
    "    stop_on: all_checked",
    "  - id: verify",
    "    stop_on: all_checked",
    "---",
    "",
    "<!-- loopy:phase plan -->",
    "- [ ] Plan task",
    "",
    "<!-- loopy:phase implement -->",
    "- [ ] Implement task",
    "",
    "<!-- loopy:phase verify -->",
    "- [ ] Verify task",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  const result = pickCurrentPhaseId(parsed, {}, {});
  assert.equal(result, "plan");
});

test("pickCurrentPhaseId: advances to next incomplete phase", () => {
  const text = [
    "---",
    "phases:",
    "  - id: plan",
    "    stop_on: all_checked",
    "  - id: implement",
    "    stop_on: all_checked",
    "  - id: verify",
    "    stop_on: all_checked",
    "---",
    "",
    "<!-- loopy:phase plan -->",
    "- [x] Plan task",
    "",
    "<!-- loopy:phase implement -->",
    "- [ ] Implement task",
    "",
    "<!-- loopy:phase verify -->",
    "- [ ] Verify task",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  const state = { currentPhase: "plan" };
  const result = pickCurrentPhaseId(parsed, state, {});
  assert.equal(result, "implement");
});

test("pickCurrentPhaseId: does NOT wrap back to earlier phase when later phases are complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: plan",
    "    stop_on: all_checked",
    "  - id: implement",
    "    stop_on: all_checked",
    "  - id: verify",
    "    stop_on: all_checked",
    "---",
    "",
    "<!-- loopy:phase plan -->",
    "- [ ] Plan task still open",
    "",
    "<!-- loopy:phase implement -->",
    "- [x] Implement task",
    "",
    "<!-- loopy:phase verify -->",
    "- [x] Verify task",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  // Current phase is implement, and both implement+verify are complete.
  // The old buggy code would wrap around to "plan" because it has an unchecked item.
  // The fix should return the last non-skipped phase instead ("verify").
  const state = { currentPhase: "implement" };
  const result = pickCurrentPhaseId(parsed, state, {});
  assert.notEqual(result, "plan", "should NOT wrap back to earlier phase");
});

// ---------------------------------------------------------------------------
// Two-gate model — new tests
// ---------------------------------------------------------------------------

test("isPhaseComplete: unchecked tasks → NOT complete even if tests pass", () => {
  const text = [
    "---",
    "phases:",
    "  - id: impl",
    "    test_command: npm test",
    "---",
    "",
    "<!-- loopy:phase impl -->",
    "- [x] Task A",
    "- [ ] Task B (still open)",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  const state = { lastTest: "pass @ 2026-02-06T12:00:00" };
  assert.equal(isPhaseComplete(parsed, "impl", state), false, "Gate 1 not met — unchecked tasks");
});

test("isPhaseComplete: phase without test_command completes on all_checked alone", () => {
  const text = [
    "---",
    "phases:",
    "  - id: docs",
    "---",
    "",
    "<!-- loopy:phase docs -->",
    "- [x] Write README",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(isPhaseComplete(parsed, "docs", state), true, "No test_command → Gate 2 not needed");
});

test("isPhaseComplete: skipped tasks [~] count as checked for Gate 1", () => {
  const text = [
    "---",
    "phases:",
    "  - id: impl",
    "---",
    "",
    "<!-- loopy:phase impl -->",
    "- [x] Task A",
    "- [~] Task B (skipped: not applicable)",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(isPhaseComplete(parsed, "impl", {}), true, "Skipped tasks satisfy Gate 1");
});

test("isPhaseComplete: skipped tasks [-] count as checked for Gate 1", () => {
  const text = [
    "---",
    "phases:",
    "  - id: impl",
    "---",
    "",
    "<!-- loopy:phase impl -->",
    "- [x] Task A",
    "- [-] Task B (cancelled: duplicate)",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(isPhaseComplete(parsed, "impl", {}), true, "Cancelled tasks satisfy Gate 1");
});

test("isPhaseComplete: legacy stop_on: tests_pass without test_command → complete when all checked", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "    stop_on: tests_pass",
    "---",
    "",
    "<!-- loopy:phase build -->",
    "- [x] Build task",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  // Under the new model, stop_on is ignored. No test_command means Gate 2 not needed.
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(isPhaseComplete(parsed, "build", state), true);
});

test("isPhaseAllChecked: returns false when tasks remain unchecked", () => {
  const text = [
    "---",
    "phases:",
    "  - id: impl",
    "---",
    "",
    "<!-- loopy:phase impl -->",
    "- [x] Done",
    "- [ ] Not done",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(isPhaseAllChecked(parsed, "impl"), false);
});

test("isPhaseAllChecked: returns true when all tasks checked or skipped", () => {
  const text = [
    "---",
    "phases:",
    "  - id: impl",
    "---",
    "",
    "<!-- loopy:phase impl -->",
    "- [x] Done",
    "- [~] Skipped",
    "- [-] Cancelled",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(isPhaseAllChecked(parsed, "impl"), true);
});

test("phaseHasTestCommand: returns true when test_command configured", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "    test_command: npm test",
    "  - id: docs",
    "---",
    "",
    "<!-- loopy:phase build -->",
    "- [ ] Build",
    "",
    "<!-- loopy:phase docs -->",
    "- [ ] Docs",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(phaseHasTestCommand(parsed, "build"), true);
  assert.equal(phaseHasTestCommand(parsed, "docs"), false);
});

test("phaseHasTestCommand: inherits from phase_defaults", () => {
  const text = [
    "---",
    "phase_defaults:",
    "  test_command: npm test",
    "phases:",
    "  - id: build",
    "  - id: docs",
    "---",
    "",
    "<!-- loopy:phase build -->",
    "- [ ] Build",
    "",
    "<!-- loopy:phase docs -->",
    "- [ ] Docs",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  assert.equal(phaseHasTestCommand(parsed, "build"), true);
  assert.equal(phaseHasTestCommand(parsed, "docs"), true);
});

// ---------------------------------------------------------------------------
// pickCurrentPhaseId — sequence / no wrap-around tests
// ---------------------------------------------------------------------------

test("pickCurrentPhaseId: respects forward-only order from current phase", () => {
  const text = [
    "---",
    "phases:",
    "  - id: alpha",
    "    stop_on: all_checked",
    "  - id: beta",
    "    stop_on: all_checked",
    "  - id: gamma",
    "    stop_on: all_checked",
    "---",
    "",
    "<!-- loopy:phase alpha -->",
    "- [ ] Alpha open task",
    "",
    "<!-- loopy:phase beta -->",
    "- [x] Beta done",
    "",
    "<!-- loopy:phase gamma -->",
    "- [ ] Gamma open task",
    "",
  ].join("\n");
  const parsed = parseTask(text);
  // State says we are on beta; beta is complete.
  // Should advance to gamma (not wrap back to alpha).
  const state = { currentPhase: "beta" };
  const result = pickCurrentPhaseId(parsed, state, {});
  assert.equal(result, "gamma");
});
