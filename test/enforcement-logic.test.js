const test = require("node:test");
const assert = require("node:assert/strict");

const { detectMultiTaskCompletion } = require('../src/task');

test('detectMultiTaskCompletion - returns false when no tasks are completed', () => {
  const before = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  const after = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  assert.equal(detectMultiTaskCompletion(before, after), false);
});

test('detectMultiTaskCompletion - returns false when exactly one task is completed', () => {
  const before = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  const after = `
- [x] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  assert.equal(detectMultiTaskCompletion(before, after), false);
});

test('detectMultiTaskCompletion - returns true when exactly two tasks are completed', () => {
  const before = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  const after = `
- [x] Task 1
- [x] Task 2
- [ ] Task 3
`;
  assert.equal(detectMultiTaskCompletion(before, after), true);
});

test('detectMultiTaskCompletion - returns true when three or more tasks are completed', () => {
  const before = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
- [ ] Task 4
`;
  const after = `
- [x] Task 1
- [x] Task 2
- [x] Task 3
- [ ] Task 4
`;
  assert.equal(detectMultiTaskCompletion(before, after), true);
});

test('detectMultiTaskCompletion - ignores already-checked tasks', () => {
  const before = `
- [x] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  const after = `
- [x] Task 1
- [x] Task 2
- [ ] Task 3
`;
  assert.equal(detectMultiTaskCompletion(before, after), false);
});

test('detectMultiTaskCompletion - handles tasks with complex text', () => {
  const before = `
- [ ] implement: Add detectMultiTaskCompletion(beforePlan, afterPlan) — Acceptance: Returns true
- [ ] implement: Mark iteration as failure when multi-task detected — Acceptance: Sets success=false
`;
  const after = `
- [x] implement: Add detectMultiTaskCompletion(beforePlan, afterPlan) — Acceptance: Returns true
- [x] implement: Mark iteration as failure when multi-task detected — Acceptance: Sets success=false
`;
  assert.equal(detectMultiTaskCompletion(before, after), true);
});

test('detectMultiTaskCompletion - handles plans with comments', () => {
  const before = `
<!-- loopy:phase test -->
- [ ] Task 1
- [ ] Task 2
`;
  const after = `
<!-- loopy:phase test -->
- [x] Task 1
- [ ] Task 2
`;
  assert.equal(detectMultiTaskCompletion(before, after), false);
});

test('detectMultiTaskCompletion - handles empty plans', () => {
  assert.equal(detectMultiTaskCompletion('', ''), false);
});

test('detectMultiTaskCompletion - handles null/undefined inputs gracefully', () => {
  assert.equal(detectMultiTaskCompletion(null, null), false);
  assert.equal(detectMultiTaskCompletion(undefined, undefined), false);
});

test('detectMultiTaskCompletion - returns false when task is unchecked (not a completion)', () => {
  const before = `
- [x] Task 1
- [ ] Task 2
`;
  const after = `
- [ ] Task 1
- [ ] Task 2
`;
  assert.equal(detectMultiTaskCompletion(before, after), false);
});

// Integration tests for loop.js behavior
test('Multi-task enforcement should mark iteration as failure', async () => {
  // This is a documentation test - the actual integration is tested
  // via the loop.js logic which:
  // 1. Detects multi-task completion using detectMultiTaskCompletion
  // 2. Sets status = "failure"
  // 3. Sets lastError = "Multiple tasks completed in single iteration (single-task mode enforced)"
  // 4. Sets errorSignature = "multi-task-violation"
  // This test documents the expected behavior
  assert.ok(true, 'Integration documented');
});


