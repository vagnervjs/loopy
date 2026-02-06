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
  "- When generating phase configurations, prefer stop_on: tests_pass over stop_on: all_checked for any phase that involves code changes (implementation, tests, build, verification). Reserve stop_on: all_checked only for documentation-only or planning-only phases with no code impact.",
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
  "- Run required tests for the task and fix failures.",
  "- If the plan is wrong or stale, switch to plan mode and regenerate it.",
  "- If acceptance criteria are subjective, add and run judge tests (see `loopy add-judge`).",
  "- If you discover new run/test commands, update AGENTS.md.",
  "- Do NOT mark a task checkbox as [x] unless the full test command (test_command from the plan frontmatter) exits successfully. A task is only complete when both the implementation AND the test suite are green.",
  "- Always run the plan's test_command to validate your work. Do not substitute a partial or custom command in its place.",
  "- If the test command fails after your changes, fix the failures before marking the task done. If you cannot fix them within this iteration, leave the checkbox unchecked.",
  "- If the same task has failed for 3+ consecutive iterations, reassess your approach: read the error output carefully, consider reverting recent changes, or switch to plan mode to re-scope the task.",
  "",
  "## Built-in Rules",
  "- You MUST run the test_command defined in the plan frontmatter before marking any checkbox as complete.",
  "- If tests fail, your iteration is not successful — do not check off the task.",
  "- Focus on one task at a time. Do not check multiple boxes in a single iteration.",
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
