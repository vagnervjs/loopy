const path = require("path");
const nodeFs = require("fs");

const { prettyPath, resolveFrom } = require("../config");

const DEFAULT_PLAN_PROMPT_TEMPLATE = [
  "# Loopy Plan Prompt",
  "",
  "Timestamp: {{timestamp}}",
  "",
  "You are in PLANNING mode.",
  "Goal: update the plan only. Do NOT implement anything. No code edits. No commits.",
  "",
  "## Context",
  "{{seed_block}}",
  "",
  "{{hints_block}}",
  "",
  "{{specs_block}}",
  "",
  "{{agents_block}}",
  "",
  "## Requirements",
  "Study these sources before planning:",
  "- `specs/*` (requirements)",
  "- `src/*` (current implementation)",
  "Use subagents for study and investigation; use only one subagent for tests.",
  "",
  "## Plan",
  "Compare specs against code. Produce a prioritized plan that closes gaps.",
  "If the existing plan is wrong or stale, replace it.",
  "Keep tasks atomic, testable, and outcome-focused.",
  "Do not assume anything is missing; search first.",
  "If acceptance criteria are subjective, add judge tests (see `loopy add-judge`).",
  "- Phases use a two-gate completion model: Gate 1 = all tasks checked, Gate 2 = test_command passes. Tests are only run after all tasks in a phase are checked.",
  "- The stop_on field is deprecated. All phases follow the two-gate model automatically.",
  "- If a task is impossible to complete, mark it as skipped with [~] or [-] and include the reason in the task text.",
  "",
  "## Current Plan",
  "{{plan}}",
  "",
  "## Guardrails",
  "{{guardrails}}",
  "",
  "## Output Rules",
  "- Plan only.",
  "- No implementation steps.",
  "- No commits.",
  "- Keep tasks small and unambiguous.",
  "",
].join("\n");

const DEFAULT_BUILD_PROMPT_TEMPLATE = [
  "# Loopy Build Prompt",
  "",
  "Timestamp: {{timestamp}}",
  "Iteration: {{iteration}}",
  "",
  "You are in BUILDING mode.",
  "Goal: complete exactly one task from the current plan.",
  "",
  "## Context",
  "{{seed_block}}",
  "",
  "{{hints_block}}",
  "",
  "{{specs_block}}",
  "",
  "{{agents_block}}",
  "",
  "{{current_task_block}}",
  "",
  "## Plan",
  "{{plan}}",
  "",
  "## Guardrails",
  "{{guardrails}}",
  "",
  "## Task Rules",
  "- Use subagents to study specs/code; use only one subagent for tests.",
  "- Do not assume functionality is missing; search first.",
  "- If the plan is wrong or stale, switch to plan mode and regenerate it.",
  "- If acceptance criteria are subjective, add and run judge tests (see `loopy add-judge`).",
  "- If you discover new run/test commands, update AGENTS.md.",
  "- Complete all unchecked tasks in the current phase before tests will be run.",
  "- Mark a task checkbox as [x] when the implementation is done. The test_command runs automatically after all phase tasks are checked.",
  "- If a task is impossible or should be skipped, mark it with [~] or [-] and explain the reason inline.",
  "- If the test command fails after all tasks are checked, fix the failures before the phase can advance. Do not move on with broken tests.",
  "- If the same task has failed for 3+ consecutive iterations, reassess your approach: read the error output carefully, consider reverting recent changes, or switch to plan mode to re-scope the task.",
  "",
  "## Built-in Rules",
  "- Phases follow a two-gate lifecycle: Gate 1 = all tasks checked [x], Gate 2 = test_command passes.",
  "- The test_command is NOT executed until every task in the current phase is checked. Focus on completing tasks first.",
  "- Focus on one task at a time. Do not check multiple boxes in a single iteration.",
  "- Never cycle back to a previous phase. Phases are sequential and one-directional.",
  "",
  "{{instructions}}",
  "",
].join("\n");

async function readPromptTemplate(filePath, { required, cwd } = {}) {
  const target = String(filePath || "").trim();
  if (!target) return { text: "", path: "" };
  try {
    const data = await nodeFs.promises.readFile(target, "utf8");
    return { text: data, path: target };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      if (required) {
        throw new Error(`Prompt template not found: ${prettyPath(cwd || process.cwd(), target)}`);
      }
      return { text: "", path: "" };
    }
    throw err;
  }
}

async function loadPromptTemplate(config) {
  const mode = String(config.mode || "build").trim().toLowerCase();
  const explicit = String(config.promptTemplate || "").trim();
  if (explicit) {
    const abs = resolveFrom(config.cwd, explicit);
    const loaded = await readPromptTemplate(abs, { required: true, cwd: config.cwd });
    if (!String(loaded.text || "").trim()) {
      throw new Error(`Prompt template is empty: ${prettyPath(config.cwd, abs)}`);
    }
    return { text: loaded.text, path: abs, source: "--prompt-template" };
  }

  const filename = mode === "plan" ? "PROMPT_plan.md" : "PROMPT_build.md";
  const candidates = [
    resolveFrom(config.cwd, filename),
    path.join(config.loopyDir || resolveFrom(config.cwd, ".loopy"), filename),
  ];
  for (const candidate of candidates) {
    const loaded = await readPromptTemplate(candidate, { required: false, cwd: config.cwd });
    if (String(loaded.text || "").trim()) {
      return { text: loaded.text, path: candidate, source: "default" };
    }
  }
  if (mode === "plan") {
    return { text: DEFAULT_PLAN_PROMPT_TEMPLATE, path: "", source: "built-in" };
  }
  return { text: DEFAULT_BUILD_PROMPT_TEMPLATE, path: "", source: "built-in" };
}

module.exports = {
  loadPromptTemplate,
};
