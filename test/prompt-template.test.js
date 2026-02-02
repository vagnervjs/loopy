const test = require("node:test");
const assert = require("node:assert/strict");

const { formatPrompt } = require("../src/prompt");

test("formatPrompt - uses template override when provided", () => {
  const template = "Hello {{iteration}}\n{{plan}}\n{{instructions}}";
  const prompt = formatPrompt({
    iteration: 2,
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
    promptTemplate: template,
  });

  assert.match(prompt, /Hello 2/);
  assert.match(prompt, /# Plan/);
  assert.match(prompt, /Follow the plan checklist/);
  assert.doesNotMatch(prompt, /# Loopy Loop Prompt/);
});
