const { suite } = require("./suite");
const test = suite("phase-completion");
const assert = require("node:assert/strict");

const { isPhaseComplete, areAllPhasesComplete, pickCurrentPhaseId } = require("../src/loop/phases");
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

test("areAllPhasesComplete: all boxes checked + tests failing + phase has stop_on tests_pass → NOT complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "    stop_on: all_checked",
    "  - id: validate",
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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

test("areAllPhasesComplete: all boxes checked + tests passing + phase has stop_on tests_pass → complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build",
    "    stop_on: all_checked",
    "  - id: validate",
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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

test("areAllPhasesComplete: all boxes checked + tests failing + ALL phases stop_on all_checked → complete (backward compat)", () => {
  const text = [
    "---",
    "phases:",
    "  - id: alpha",
    "    stop_on: all_checked",
    "  - id: beta",
    "    stop_on: all_checked",
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

  // Tests failing, but no phase requires tests_pass — should still be complete
  const state = { lastTest: "fail @ 2026-02-06T12:00:00" };
  assert.equal(areAllPhasesComplete(parsed, state), true);
});

// ---------------------------------------------------------------------------
// Early-exit path: allChecked + phase requires tests_pass + last test failed
// ---------------------------------------------------------------------------

test("early exit: allChecked true but state.lastTest is fail with tests_pass phase → areAllPhasesComplete returns false", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build-modules",
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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
    "Should NOT be complete when tests_pass required and lastTest is fail"
  );
});

test("early exit: allChecked true + state.lastTest is pass with tests_pass phase → areAllPhasesComplete returns true", () => {
  const text = [
    "---",
    "phases:",
    "  - id: build-modules",
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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
    "Should be complete when tests_pass required and lastTest is pass"
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

test("isPhaseComplete: phase with tests_pass + tests failing → NOT complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: core",
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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

test("isPhaseComplete: phase with tests_pass + tests passing → complete", () => {
  const text = [
    "---",
    "phases:",
    "  - id: core",
    "    stop_on:",
    "      - all_checked",
    "      - tests_pass",
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
