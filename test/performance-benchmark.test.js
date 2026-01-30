const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCheckboxes, compareCheckboxDiffs } = require("../src/task");

test("Performance: parseCheckboxes completes under 5ms for typical plan", () => {
  // Create a typical plan with multiple tasks
  const typicalPlan = `
## Phase: validation
- [x] test: Run 100 single-task iterations
- [ ] test: Verify multi-task scenario triggers enforcement
- [ ] test: Confirm performance overhead under 10ms
- [ ] verify: Run full test suite
- [ ] verify: Manual test of --single-task flag

## Phase: implementation
- [x] feat: Add checkbox diff detection
- [x] feat: Add single-task enforcement logic
- [ ] feat: Add CLI flag for single-task mode
- [ ] feat: Update prompt template

## Phase: documentation
- [ ] docs: Document single-task mode
- [ ] docs: Add examples to README
- [ ] docs: Update CLI help text
  `.trim();

  const iterations = 1000;
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    parseCheckboxes(typicalPlan);
  }
  
  const end = performance.now();
  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  
  assert.ok(avgTime < 5, `Average time ${avgTime.toFixed(3)}ms exceeds 5ms threshold`);
});

test("Performance: compareCheckboxDiffs completes under 10ms for typical diff", () => {
  const beforePlan = `
## Phase: validation
- [ ] test: Run 100 single-task iterations
- [ ] test: Verify multi-task scenario triggers enforcement
- [ ] test: Confirm performance overhead under 10ms
- [ ] verify: Run full test suite
- [ ] verify: Manual test of --single-task flag

## Phase: implementation
- [x] feat: Add checkbox diff detection
- [x] feat: Add single-task enforcement logic
- [ ] feat: Add CLI flag for single-task mode
- [ ] feat: Update prompt template
  `.trim();

  const afterPlan = `
## Phase: validation
- [x] test: Run 100 single-task iterations
- [ ] test: Verify multi-task scenario triggers enforcement
- [ ] test: Confirm performance overhead under 10ms
- [ ] verify: Run full test suite
- [ ] verify: Manual test of --single-task flag

## Phase: implementation
- [x] feat: Add checkbox diff detection
- [x] feat: Add single-task enforcement logic
- [ ] feat: Add CLI flag for single-task mode
- [ ] feat: Update prompt template
  `.trim();

  const iterations = 1000;
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    compareCheckboxDiffs(beforePlan, afterPlan);
  }
  
  const end = performance.now();
  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  
  assert.ok(avgTime < 10, `Average time ${avgTime.toFixed(3)}ms exceeds 10ms threshold`);
});

test("Performance: checkbox diff with large plan under 10ms", () => {
  // Create a large plan with 50 tasks across 5 phases
  let beforePlan = "";
  let afterPlan = "";
  
  for (let phase = 1; phase <= 5; phase++) {
    beforePlan += `\n## Phase: phase-${phase}\n`;
    afterPlan += `\n## Phase: phase-${phase}\n`;
    
    for (let task = 1; task <= 10; task++) {
      const checked = task <= 3 ? "x" : " ";
      beforePlan += `- [${checked}] task: Task ${task} in phase ${phase}\n`;
      
      // In after plan, check one more task in phase 1
      const afterChecked = (phase === 1 && task === 4) ? "x" : checked;
      afterPlan += `- [${afterChecked}] task: Task ${task} in phase ${phase}\n`;
    }
  }

  const iterations = 1000;
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    compareCheckboxDiffs(beforePlan, afterPlan);
  }
  
  const end = performance.now();
  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  
  assert.ok(avgTime < 10, `Average time ${avgTime.toFixed(3)}ms exceeds 10ms threshold for large plan`);
});

test("Performance: checkbox diff worst case (all tasks checked) under 10ms", () => {
  // Worst case: many tasks transitioning from unchecked to checked
  const tasks = [];
  for (let i = 1; i <= 100; i++) {
    tasks.push(`- [ ] task: Task ${i}`);
  }
  const beforePlan = tasks.join("\n");
  
  const checkedTasks = tasks.map(t => t.replace("[ ]", "[x]"));
  const afterPlan = checkedTasks.join("\n");

  const iterations = 500;
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    compareCheckboxDiffs(beforePlan, afterPlan);
  }
  
  const end = performance.now();
  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  
  assert.ok(avgTime < 10, `Average time ${avgTime.toFixed(3)}ms exceeds 10ms threshold for worst case`);
});
