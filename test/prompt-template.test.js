const { suite } = require("./suite");
const test = suite("prompt-template");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { formatPrompt, formatProgress } = require("../src/prompt");
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
  assert.match(result.text, /loopy_test_report/);
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
  assert.match(result.text, /validation report gate is NOT evaluated until every task/i);
  assert.match(result.text, /Focus on one task at a time/);
  assert.match(result.text, /Never cycle back to a previous phase/);
});

test("built-in build template includes blocked task guidance", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-blocked-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "build",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /\[!\]/);
  assert.match(result.text, /BLOCKED/i);
  assert.match(result.text, /do not block phase advancement/i);
});

test("built-in plan template includes blocked task guidance", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tpl-blocked-plan-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const result = await loadPromptTemplate({
    mode: "plan",
    cwd: tmp,
    loopyDir,
  });

  assert.equal(result.source, "built-in");
  assert.match(result.text, /\[!\]/);
  assert.match(result.text, /BLOCKED/i);
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
  assert.match(result.text, /validation report passes/);
  assert.match(result.text, /\[~\] or \[-\]/);
});

// ── formatProgress ──────────────────────────────────────────────────────

test("formatProgress - includes blocked tasks section", () => {
  const state = {
    iteration: 5,
    blockedTasks: [
      { task: "update Jest config", reason: "pre-existing Node 23 incompatibility", iteration: 4 },
    ],
  };
  const progress = formatProgress(state);
  assert.match(progress, /## Blocked Tasks/);
  assert.match(progress, /\[!\] update Jest config/);
  assert.match(progress, /pre-existing Node 23 incompatibility/);
  assert.match(progress, /iteration 4/);
});

test("formatProgress - includes thrash-blocked tasks section", () => {
  const state = {
    iteration: 10,
    thrashBlockedTasks: [
      { task: "fix jest config", files: ["jest.config.js"], iteration: 8, reason: "file thrashing escalation (level 3)" },
    ],
  };
  const progress = formatProgress(state);
  assert.match(progress, /## Thrash-Blocked Tasks/);
  assert.match(progress, /fix jest config/);
  assert.match(progress, /jest\.config\.js/);
});

test("formatProgress - omits blocked/thrash sections when empty", () => {
  const state = { iteration: 1 };
  const progress = formatProgress(state);
  assert.doesNotMatch(progress, /## Blocked Tasks/);
  assert.doesNotMatch(progress, /## Thrash-Blocked Tasks/);
});
