const { suite } = require("./suite");
const test = suite("prompt-modifications");
const assert = require("node:assert/strict");

const { getCurrentTask, getCurrentPhaseSection } = require("../src/task");
const { formatPrompt } = require("../src/prompt");

test("getCurrentTask - returns first unchecked task from current phase", () => {
  const planText = `---
test: npm test
---

# Plan

## Phase: alpha
<!-- loopy:phase alpha -->
- [x] completed task
- [ ] current task to work on
- [ ] future task

## Phase: beta
<!-- loopy:phase beta -->
- [ ] beta task
`;

  const task = getCurrentTask(planText, { phaseId: "alpha" });
  assert.notEqual(task, null);
  assert.equal(task.text, "current task to work on");
  assert.equal(task.checked, false);
});

test("getCurrentTask - returns null if all tasks are checked", () => {
  const planText = `---
test: npm test
---

# Plan

## Phase: alpha
<!-- loopy:phase alpha -->
- [x] completed task
- [x] another completed task
`;

  const task = getCurrentTask(planText, { phaseId: "alpha" });
  assert.equal(task, null);
});

test("getCurrentTask - works with non-phased plans", () => {
  const planText = `---
test: npm test
---

# Plan

- [x] done
- [ ] next task
- [ ] later
`;

  const task = getCurrentTask(planText);
  assert.notEqual(task, null);
  assert.equal(task.text, "next task");
});

test("getCurrentPhaseSection - returns only current phase section", () => {
  const planText = `---
test: npm test
phases:
  - id: alpha
    title: Alpha Phase
  - id: beta
    title: Beta Phase
  - id: gamma
    title: Gamma Phase
---

# Plan

## Phase: alpha
<!-- loopy:phase alpha -->
- [ ] alpha task 1
- [ ] alpha task 2

## Phase: beta
<!-- loopy:phase beta -->
- [ ] beta task 1
- [ ] beta task 2

## Phase: gamma
<!-- loopy:phase gamma -->
- [ ] gamma task 1
`;

  const filtered = getCurrentPhaseSection(planText, "beta");
  assert.match(filtered, /## Phase: beta/);
  assert.match(filtered, /beta task 1/);
  assert.match(filtered, /beta task 2/);
  assert.doesNotMatch(filtered, /## Phase: alpha/);
  assert.doesNotMatch(filtered, /## Phase: gamma/);
  assert.doesNotMatch(filtered, /alpha task 1/);
  assert.doesNotMatch(filtered, /gamma task 1/);
});

test("getCurrentPhaseSection - includes front matter and plan header", () => {
  const planText = `---
test: npm test
phases:
  - id: alpha
    title: Alpha Phase
---

# Plan

## Phase: alpha
<!-- loopy:phase alpha -->
- [ ] alpha task
`;

  const filtered = getCurrentPhaseSection(planText, "alpha");
  assert.match(filtered, /---/);
  assert.match(filtered, /test: npm test/);
  assert.match(filtered, /# Plan/);
});

test("getCurrentPhaseSection - returns original text if no phaseId provided", () => {
  const planText = `# Plan\n- [ ] task`;
  const filtered = getCurrentPhaseSection(planText, "");
  assert.equal(filtered, planText);
});

test("formatPrompt - includes Current Task section when currentTask is provided", () => {
  const prompt = formatPrompt({
    iteration: 1,
    taskText: "# Plan\n- [ ] task",
    taskSeedText: "",
    taskSeedSource: "",
    guardrailsText: "# Guardrails\n",
    progressText: "# Progress\n",
    lastOutput: "",
    rotationPending: false,
    currentPhase: "alpha",
    taskFilePath: "LOOPY_PLAN.md",
    hintsText: "",
    currentTask: "implement feature X",
    filteredPlan: null,
  });

  assert.match(prompt, /## Current Task/);
  assert.match(prompt, /- \[ \] implement feature X/);
});

test("formatPrompt - includes explicit single-task instruction when currentTask is provided", () => {
  const prompt = formatPrompt({
    iteration: 1,
    taskText: "# Plan\n- [ ] task",
    taskSeedText: "",
    taskSeedSource: "",
    guardrailsText: "# Guardrails\n",
    progressText: "# Progress\n",
    lastOutput: "",
    rotationPending: false,
    currentPhase: "alpha",
    taskFilePath: "LOOPY_PLAN.md",
    hintsText: "",
    currentTask: "implement feature X",
    filteredPlan: null,
  });

  assert.match(prompt, /\*\*Complete only the Current Task in this iteration\.\*\*/);
});

test("formatPrompt - uses filtered plan when provided", () => {
  const fullPlan = `# Plan

## Phase: alpha
- [ ] alpha task

## Phase: beta
- [ ] beta task`;

  const filteredPlan = `# Plan

## Phase: alpha
- [ ] alpha task`;

  const prompt = formatPrompt({
    iteration: 1,
    taskText: fullPlan,
    taskSeedText: "",
    taskSeedSource: "",
    guardrailsText: "# Guardrails\n",
    progressText: "# Progress\n",
    lastOutput: "",
    rotationPending: false,
    currentPhase: "alpha",
    taskFilePath: "LOOPY_PLAN.md",
    hintsText: "",
    currentTask: "alpha task",
    filteredPlan,
  });

  assert.match(prompt, /alpha task/);
  assert.doesNotMatch(prompt, /beta task/);
  assert.match(prompt, /## Phase: alpha/);
  assert.doesNotMatch(prompt, /## Phase: beta/);
});

test("formatPrompt - does not include Current Task section when currentTask is null", () => {
  const prompt = formatPrompt({
    iteration: 1,
    taskText: "# Plan\n- [x] all done",
    taskSeedText: "",
    taskSeedSource: "",
    guardrailsText: "# Guardrails\n",
    progressText: "# Progress\n",
    lastOutput: "",
    rotationPending: false,
    currentPhase: "alpha",
    taskFilePath: "LOOPY_PLAN.md",
    hintsText: "",
    currentTask: null,
    filteredPlan: null,
  });

  assert.doesNotMatch(prompt, /## Current Task/);
  assert.doesNotMatch(prompt, /\*\*Complete only the Current Task in this iteration\.\*\*/);
});

test("formatPrompt - includes AGENTS and specs summary when provided", () => {
  const prompt = formatPrompt({
    iteration: 1,
    taskText: "# Plan\n- [ ] task",
    taskSeedText: "",
    taskSeedSource: "",
    guardrailsText: "# Guardrails\n",
    progressText: "# Progress\n",
    lastOutput: "",
    rotationPending: false,
    currentPhase: "",
    taskFilePath: "LOOPY_PLAN.md",
    hintsText: "",
    currentTask: null,
    filteredPlan: null,
    agentsText: "## Build & Run\n- npm run dev",
    specsText: "- auth.md — Auth",
  });

  assert.match(prompt, /## Specs Summary/);
  assert.match(prompt, /auth\.md — Auth/);
  assert.match(prompt, /## AGENTS/);
  assert.match(prompt, /npm run dev/);
});
