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
  "{{prd_refs_block}}",
  "",
  "## Requirements",
  "Study these sources before planning:",
  "- `.loopy/PRD.md` (requirements)",
  "- `src/*` (current implementation)",
  "Use subagents for study and investigation; use only one subagent for tests.",
  "",
  "## Plan",
  "Compare specs against code. Produce a prioritized plan that closes gaps.",
  "When the root cause of a problem is unclear, plan investigation tasks before implementation tasks.",
  "Investigation tasks gather evidence (measurements, comparisons, API queries, log analysis) that informs what to fix.",
  "Do not propose implementation changes to fix a problem you have not diagnosed -- plan the diagnosis first.",
  "If the existing plan is wrong or stale, replace it.",
  "Keep tasks atomic, testable, and outcome-focused.",
  "Tasks must be specific: include file paths, function names, or config keys when the target is known or discoverable.",
  "Remove or rephrase tasks that a code agent cannot complete in a single session (long-running monitoring, manual approvals, multi-week tracking).",
  "Every task must be verifiable with data available RIGHT NOW. Never plan tasks that depend on future events (e.g., 'wait for N future CI runs', 'measure post-deploy metrics over 2 weeks', 'compare before/after using future data'). If post-change validation needs future data, add it to `.loopy/FOLLOW_UP.md` instead of creating a plan task. The follow-up file is a human-reviewed checklist that survives archiving.",
  "Do not assume anything is missing; search first.",
  "If acceptance criteria are subjective, add judge tests (see `loopy add-judge`).",
  "- Use explicit `prd_refs` in tasks/phases when requirements are not obvious from the task text.",
  "- Phases use a two-gate completion model: Gate 1 = all tasks checked, Gate 2 = validation report passes.",
  "- If a task is impossible to complete, mark it as skipped with [~] or [-] and include the reason in the task text.",
  "- If a task is blocked by external factors after 3+ consecutive failures, mark it as [!] with a BLOCKED reason (e.g., `[!] task description — BLOCKED: reason`). Blocked tasks are excluded from phase gates.",
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
  "You are in BUILDING mode. Complete exactly one task from the current plan.",
  "",
  "{{current_task_block}}",
  "",
  "## Situation",
  "Phase: {{phase}} | Iteration: {{iteration}} | Rotation: {{rotation}}",
  "",
  "{{progress}}",
  "",
  "{{last_output_block}}",
  "",
  "## Context",
  "{{hints_block}}",
  "",
  "{{prd_refs_block}}",
  "",
  "## Plan",
  "{{plan}}",
  "",
  "## Requirements",
  "{{seed_block}}",
  "",
  "## Rules",
  "- Do not assume functionality is missing; search first.",
  "- No stubs or placeholder implementations.",
  "- Use subagents to study PRD/code; use only one subagent for tests.",
  "- Use `.loopy/PRD.md` and the listed `prd_refs` before requirement-level decisions.",
  "- Keep changes focused and maintain repo state.",
  "- Focus on one task at a time. Do not check multiple boxes in a single iteration.",
  "- Mark a task checkbox as [x] when the implementation is done.",
  "- If a task is impossible or should be skipped, mark it with [~] or [-] and explain the reason inline.",
  "- If a task is blocked by external factors after 3+ consecutive failures, mark it as [!] with a reason: `[!] task — BLOCKED: reason`. Blocked tasks do not block phase advancement.",
  "- Complete all unchecked tasks in the current phase before tests will be run.",
  "- Execute tests in your workflow and include a valid ```loopy_test_report``` JSON block in your response. Required schema: `{ \"status\": \"pass|fail|skipped\", \"command\": \"the test command run\", \"summary\": \"one-line result\", \"evidence\": \"relevant output excerpt\" }`. All four fields are required strings. Do NOT use arrays, nested objects, or extra fields like `tests` or `phase`.",
  "- If tests fail after all tasks are checked, fix the failures before the phase can advance. Do not move on with broken tests.",
  "- If the same task has failed for 3+ consecutive iterations, reassess your approach: read the error output carefully, consider reverting recent changes, or switch to plan mode to re-scope the task.",
  "- If the plan is wrong or stale, switch to plan mode and regenerate it.",
  "- If acceptance criteria are subjective, add and run judge tests (see `loopy add-judge`).",
  "- Record any new guardrails if you detect repetition or drift.",
  "- If your work reveals validation steps, metrics checks, or verifications that cannot be performed now because they depend on future data (e.g., future CI runs, post-deploy observations, production traffic), append them to `.loopy/FOLLOW_UP.md` as checklist items. Do NOT create plan tasks for future-dependent work. The follow-up file is for humans to act on after the automated work completes.",
  "",
  "## Phase Lifecycle",
  "- Phases follow a two-gate lifecycle: Gate 1 = all tasks checked [x] (or skipped [~]/[-] or blocked [!]), Gate 2 = test report status is pass.",
  "- The validation report gate is NOT evaluated until every task in the current phase is checked. Focus on completing tasks first.",
  "- Never cycle back to a previous phase. Phases are sequential and one-directional.",
  "- When completing the LAST unchecked task of the current phase, check whether this phase produced findings, measurements, or analysis artifacts (e.g. files in `.loopy/reports/`, data gathered during investigation). If so, append a concise structured summary to `.loopy/hints.md` under a heading like `## Findings from [phase name]`. Include: what was measured, key numbers, root cause or conclusion, and recommended action. This summary carries context to the next phase's agent.",
  "- When completing the LAST task of a phase, also review the tasks in the NEXT phase of LOOPY_PLAN.md. If your work produced findings that make those tasks inaccurate, outdated, or too vague, rewrite the task descriptions and acceptance criteria to reflect what you now know. Keep the same phase id and structure. Do NOT add or remove phases or rewrite tasks beyond the next phase.",
  "",
  "## Guardrails",
  "{{guardrails}}",
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
