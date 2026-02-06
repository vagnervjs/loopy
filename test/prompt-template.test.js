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

test("built-in build template includes test-gating task rules", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-build-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "build",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /Do NOT mark a task checkbox as \[x\] unless the full test command/);
  assert.match(result.text, /Always run the plan's test_command to validate your work/);
  assert.match(result.text, /fix the failures before marking the task done/);
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
  assert.match(result.text, /MUST run the test_command defined in the plan frontmatter/);
  assert.match(result.text, /If tests fail, your iteration is not successful/);
  assert.match(result.text, /Focus on one task at a time/);
});

test("built-in plan template includes phase stop_on safeguard", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-plan-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "plan",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /prefer stop_on: tests_pass over stop_on: all_checked/);
  assert.match(result.text, /documentation-only or planning-only phases/);
});
