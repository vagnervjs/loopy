const { suite } = require("./suite");
const test = suite("prompt-template");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { formatPrompt } = require("../src/prompt");
const { loadPromptTemplate } = require("../src/loop/prompt-templates");

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

test("built-in build template includes two-gate task rules", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-build-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "build",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /Complete all unchecked tasks in the current phase before tests will be run/);
  assert.match(result.text, /test_command runs automatically after all phase tasks are checked/);
  assert.match(result.text, /fix the failures before the phase can advance/);
  assert.match(result.text, /3\+ consecutive iterations, reassess your approach/);
});

test("built-in build template includes Built-in Rules section", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-builtin-rules-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "build",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /## Built-in Rules/);
  assert.match(result.text, /two-gate lifecycle/);
  assert.match(result.text, /test_command is NOT executed until every task/);
  assert.match(result.text, /Focus on one task at a time/);
  assert.match(result.text, /Never cycle back to a previous phase/);
});

test("built-in plan template includes two-gate model guidance", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-plan-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "plan",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /two-gate completion model/);
  assert.match(result.text, /stop_on field is deprecated/);
  assert.match(result.text, /\[~\] or \[-\]/);
});
