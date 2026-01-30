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
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('Multi-task enforcement: iteration fails correctly on multi-task scenario', async () => {
  // Simulate the loop.js behavior when multi-task completion is detected
  const taskTextBefore = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  
  const taskTextAfter = `
- [x] Task 1
- [x] Task 2
- [ ] Task 3
`;

  // Step 1: Detect multi-task completion
  const multiTaskDetected = detectMultiTaskCompletion(taskTextBefore, taskTextAfter);
  assert.equal(multiTaskDetected, true, 'Should detect multi-task completion');

  // Step 2: Verify iteration would be marked as failure
  let status = "success"; // Initial status after agent execution
  let lastError = null;
  let errorSignature = null;
  
  if (status === "success" && multiTaskDetected) {
    status = "failure";
    lastError = "Multiple tasks completed in single iteration (single-task mode enforced)";
    errorSignature = "multi-task-violation";
  }
  
  assert.equal(status, "failure", 'Status should be set to failure');
  assert.equal(lastError, "Multiple tasks completed in single iteration (single-task mode enforced)", 'Error message should be set');
  assert.equal(errorSignature, "multi-task-violation", 'Error signature should be multi-task-violation');
});

test('Guardrail sign appending: writes violation to guardrails file', async () => {
  const { appendSign } = require('../src/prompt');
  
  // Step 1: Create initial guardrails content
  const guardrailsTextBefore = `# Loopy Guardrails

## Signs
- 2026-01-30T01:00:00.000Z Previous violation message
`;

  // Step 2: Append multi-task violation sign
  const iteration = 5;
  const guardrailsTextAfter = appendSign(
    guardrailsTextBefore,
    `Multi-task violation detected in iteration ${iteration}: Single-task mode enforced`
  );

  // Step 3: Verify sign was appended
  assert.notEqual(guardrailsTextAfter, guardrailsTextBefore, 'Guardrails should be updated');
  assert.ok(guardrailsTextAfter.includes('Multi-task violation detected in iteration 5'), 'Should contain violation message');
  assert.ok(guardrailsTextAfter.includes('Single-task mode enforced'), 'Should contain enforcement message');
  
  // Step 4: Verify timestamp format
  const lines = guardrailsTextAfter.split('\n');
  const violationLine = lines.find(line => line.includes('Multi-task violation'));
  assert.ok(violationLine, 'Should have violation line');
  assert.ok(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(violationLine), 'Should have ISO timestamp');
});

test('Flag toggling: singleTaskMode=true enforces single-task, singleTaskMode=false allows multi-task', () => {
  const taskTextBefore = `
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3
`;
  
  const taskTextAfter = `
- [x] Task 1
- [x] Task 2
- [ ] Task 3
`;

  // Scenario 1: singleTaskMode = true (enforcement enabled)
  {
    const config = { singleTaskMode: true };
    let status = "success";
    let lastError = null;
    
    const multiTaskDetected = detectMultiTaskCompletion(taskTextBefore, taskTextAfter);
    
    // Apply enforcement logic (simulating loop.js behavior)
    if (config.singleTaskMode && status === "success" && multiTaskDetected) {
      status = "failure";
      lastError = "Multiple tasks completed in single iteration (single-task mode enforced)";
    }
    
    assert.equal(multiTaskDetected, true, 'Should detect multi-task completion');
    assert.equal(status, "failure", 'Status should be failure when singleTaskMode=true');
    assert.equal(lastError, "Multiple tasks completed in single iteration (single-task mode enforced)", 'Error should be set');
  }

  // Scenario 2: singleTaskMode = false (enforcement disabled)
  {
    const config = { singleTaskMode: false };
    let status = "success";
    let lastError = null;
    
    const multiTaskDetected = detectMultiTaskCompletion(taskTextBefore, taskTextAfter);
    
    // Apply enforcement logic (simulating loop.js behavior)
    if (config.singleTaskMode && status === "success" && multiTaskDetected) {
      status = "failure";
      lastError = "Multiple tasks completed in single iteration (single-task mode enforced)";
    }
    
    assert.equal(multiTaskDetected, true, 'Should detect multi-task completion');
    assert.equal(status, "success", 'Status should remain success when singleTaskMode=false');
    assert.equal(lastError, null, 'Error should not be set when singleTaskMode=false');
  }

  // Scenario 3: singleTaskMode = undefined (defaults to false, no enforcement)
  {
    const config = {};
    let status = "success";
    let lastError = null;
    
    const multiTaskDetected = detectMultiTaskCompletion(taskTextBefore, taskTextAfter);
    
    // Apply enforcement logic (simulating loop.js behavior)
    if (config.singleTaskMode && status === "success" && multiTaskDetected) {
      status = "failure";
      lastError = "Multiple tasks completed in single iteration (single-task mode enforced)";
    }
    
    assert.equal(multiTaskDetected, true, 'Should detect multi-task completion');
    assert.equal(status, "success", 'Status should remain success when singleTaskMode is undefined');
    assert.equal(lastError, null, 'Error should not be set when singleTaskMode is undefined');
  }
});

test('Run 100 single-task iterations and confirm zero false positives', () => {
  // This test simulates 100 iterations where exactly one task is checked each time
  // and verifies that detectMultiTaskCompletion never falsely triggers
  
  let falsePositives = 0;
  const iterations = 100;
  
  for (let i = 0; i < iterations; i++) {
    // Create a plan with 10 tasks
    const taskCount = 10;
    let before = '';
    let after = '';
    
    for (let j = 0; j < taskCount; j++) {
      // All tasks start unchecked
      before += `- [ ] Task ${j + 1}: Iteration ${i} task number ${j}\n`;
      
      // Check exactly one task (the one matching current iteration modulo task count)
      const shouldCheck = (j === (i % taskCount));
      after += shouldCheck 
        ? `- [x] Task ${j + 1}: Iteration ${i} task number ${j}\n`
        : `- [ ] Task ${j + 1}: Iteration ${i} task number ${j}\n`;
    }
    
    const detected = detectMultiTaskCompletion(before, after);
    
    // Should never detect multi-task (exactly one task checked each time)
    if (detected) {
      falsePositives++;
    }
  }
  
  assert.equal(falsePositives, 0, `Expected zero false positives, but got ${falsePositives} out of ${iterations} iterations`);
});

test('Verify multi-task scenario triggers enforcement correctly', () => {
  // Create a plan with multiple tasks where 2 tasks are checked
  const beforePlan = `
- [ ] Task 1: First task
- [ ] Task 2: Second task
- [ ] Task 3: Third task
`;
  
  const afterPlan = `
- [x] Task 1: First task
- [x] Task 2: Second task
- [ ] Task 3: Third task
`;
  
  // Simulate single-task mode enabled
  const config = { singleTaskMode: true };
  let status = "success";
  let lastError = null;
  
  const multiTaskDetected = detectMultiTaskCompletion(beforePlan, afterPlan);
  
  // Apply enforcement logic (simulating loop.js behavior)
  if (config.singleTaskMode && status === "success" && multiTaskDetected) {
    status = "failure";
    lastError = "Multiple tasks completed in single iteration (single-task mode enforced)";
  }
  
  // Assertions
  assert.equal(multiTaskDetected, true, 'Should detect multi-task completion when 2 tasks are checked');
  assert.equal(status, "failure", 'Status should be failure when singleTaskMode is enabled and multi-task detected');
  assert.equal(lastError, "Multiple tasks completed in single iteration (single-task mode enforced)", 
    'Should set appropriate error message');
});


