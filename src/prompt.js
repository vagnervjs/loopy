const path = require("path");

function formatProgress(state) {
  const lines = [
    "# Loopy Progress",
    "",
    `- Iteration: ${state.iteration || 0}`,
    `- Current phase: ${state.currentPhase || "n/a"}`,
    `- Last status: ${state.lastStatus || "n/a"}`,
    `- Last test: ${state.lastTest || "n/a"}`,
    `- Last error: ${state.lastError || "n/a"}`,
    `- Last bytes: ${state.lastBytes || 0}`,
    `- Rotation pending: ${state.rotatePending ? "yes" : "no"}`,
    `- Started at: ${state.startedAt || "n/a"}`,
    `- Updated at: ${state.updatedAt || "n/a"}`,
  ];

  if (state.history && state.history.length) {
    lines.push("", "## History");
    for (const entry of state.history.slice(-20)) {
      lines.push(`- ${entry}`);
    }
  }

  if (state.phaseHistory && state.phaseHistory.length) {
    lines.push("", "## Phase History");
    for (const entry of state.phaseHistory.slice(-20)) {
      lines.push(`- ${entry}`);
    }
  }

  if (state.blockedTasks && state.blockedTasks.length) {
    lines.push("", "## Blocked Tasks");
    for (const bt of state.blockedTasks) {
      lines.push(`- [!] ${bt.task}${bt.reason ? ` — ${bt.reason}` : ""} (iteration ${bt.iteration || "?"})`);
    }
  }

  if (state.thrashBlockedTasks && state.thrashBlockedTasks.length) {
    lines.push("", "## Thrash-Blocked Tasks");
    for (const bt of state.thrashBlockedTasks) {
      lines.push(`- ${bt.task} — ${bt.reason || "file thrashing"} [files: ${(bt.files || []).join(", ")}] (iteration ${bt.iteration || "?"})`);
    }
  }

  return lines.join("\n") + "\n";
}

function ensureGuardrails(text) {
  if (!text || !text.trim()) {
    return "# Loopy Guardrails\n\n## Signs\n";
  }
  if (!text.includes("## Signs")) {
    return text.trimEnd() + "\n\n## Signs\n";
  }
  return text;
}

function appendSign(guardrailsText, message) {
  const updated = ensureGuardrails(guardrailsText);
  const line = `- ${new Date().toISOString()} ${message}`;
  return updated.trimEnd() + "\n" + line + "\n";
}

function applyPromptTemplate(template, tokens) {
  const text = String(template || "");
  if (!text.trim()) return "";
  const replacements = tokens && typeof tokens === "object" ? tokens : {};
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(replacements, key)) return "";
    const value = replacements[key];
    return value == null ? "" : String(value);
  });
}

function formatPrompt({
  iteration,
  taskText,
  taskSeedText,
  taskSeedSource,
  guardrailsText,
  progressText,
  lastOutput,
  rotationPending,
  currentPhase,
  taskFilePath,
  hintsText,
  currentTask,
  filteredPlan,
  promptTemplate,
  prdRefs,
}) {
  const planLabel = taskFilePath ? path.basename(String(taskFilePath)) : "plan doc";

  const seedLabel = taskSeedText
    ? `## Plan seed (PRD)${taskSeedSource ? ` (${taskSeedSource})` : ""}`
    : "";

  const rawHints = String(hintsText || "").trimEnd();
  let normalizedHints = rawHints;
  if (normalizedHints) {
    const lines = normalizedHints.split(/\r?\n/);
    if (lines[0] && lines[0].trim().toLowerCase() === "# loopy hints") {
      let i = 1;
      while (i < lines.length && lines[i].trim() === "") i += 1;
      normalizedHints = lines.slice(i).join("\n").trimEnd();
    }
  }

  const displayPlan = filteredPlan || taskText;

  const seedTextValue = taskSeedText ? String(taskSeedText).trimEnd() : "";
  const seedBlock = seedLabel && seedTextValue ? [seedLabel, seedTextValue].join("\n") : "";
  const hintsBlock = normalizedHints ? ["## Hints", normalizedHints].join("\n") : "";
  const currentTaskBlock = currentTask
    ? ["## Current Task", "", `- [ ] ${currentTask}`, ""].join("\n")
    : "";
  const lastOutputBlock = !rotationPending && lastOutput
    ? ["## Last Agent Output (truncated)", String(lastOutput).trimEnd()].join("\n")
    : "";
  const refs = Array.isArray(prdRefs) ? prdRefs : [];
  const prdRefsBlock = refs.length
    ? ["## PRD References", ...refs.map((ref) => {
      const parts = [];
      if (ref && ref.section) parts.push(`section: ${ref.section}`);
      if (ref && ref.anchor) parts.push(`anchor: ${ref.anchor}`);
      if (ref && ref.quote) parts.push(`quote: ${ref.quote}`);
      return `- ${parts.join(" | ")}`;
    })].join("\n")
    : "";
  const instructionsLines = ["## Instructions"];
  instructionsLines.push(
    "- Don't assume something is unimplemented; search first.",
    currentTask ? null : "- Complete only the current task.",
    "- Treat .loopy/PRD.md as the requirements source of truth.",
    "- No stubs or placeholder implementations.",
    `- Follow the plan checklist in ${planLabel}.`,
    "- Update plan checkboxes as you complete items.",
    "- Record any new guardrails if you detect repetition or drift.",
    "- Keep changes focused and maintain repo state.",
    "- Complete all unchecked tasks in the current phase before tests will be run.",
    "- Mark a task [x] when the implementation is done.",
    "- Run tests in the agent workflow and report them in a ```loopy_test_report``` JSON block.",
    "- If a task should be skipped, mark it with [~] or [-] and note the reason.",
    "- If a task is blocked by external factors after 3+ consecutive failures, mark it as [!] with a reason: `[!] task — BLOCKED: reason`. Blocked tasks do not block phase advancement.",
    "- If tests fail, fix the failures first.",
    "- If the same task has failed for 3+ consecutive iterations, reassess your approach."
  );
  if (currentTask) instructionsLines.push("- **Complete only the Current Task in this iteration.**");
  const instructionsBlock = instructionsLines.filter(Boolean).join("\n");
  

  const templateText = String(promptTemplate || "");
  if (templateText.trim()) {
    const tokens = {
      timestamp: new Date().toISOString(),
      iteration: String(iteration || 0),
      rotation: rotationPending ? "fresh" : "standard",
      rotation_pending: rotationPending ? "true" : "false",
      phase: currentPhase || "",
      plan_label: planLabel,
      plan: String(displayPlan || "").trimEnd(),
      seed_label: seedLabel,
      seed: seedTextValue,
      seed_block: seedBlock,
      hints: normalizedHints,
      hints_block: hintsBlock,
      prd_refs_block: prdRefsBlock,
      current_task: currentTask || "",
      current_task_block: currentTaskBlock,
      guardrails: String(guardrailsText || "").trimEnd(),
      progress: String(progressText || "").trimEnd(),
      last_output: String(lastOutput || "").trimEnd(),
      last_output_block: lastOutputBlock,
      instructions: instructionsBlock,
    };
    const rendered = applyPromptTemplate(templateText, tokens);
    if (rendered.trim()) return rendered;
  }

  const lines = [
    "# Loopy Build Prompt",
    "",
    "You are in BUILDING mode. Complete exactly one task from the current plan.",
    "",
  ];

  if (currentTask) {
    lines.push(
      "## Current Task",
      "",
      `- [ ] ${currentTask}`,
      "",
      "**Complete only the Current Task in this iteration.**",
      ""
    );
  }

  lines.push(
    "## Situation",
    `Phase: ${currentPhase || "n/a"} | Iteration: ${iteration} | Rotation: ${rotationPending ? "fresh" : "standard"}`,
    "",
    progressText.trimEnd(),
    ""
  );

  if (!rotationPending && lastOutput) {
    lines.push("## Last Agent Output (truncated)", lastOutput.trimEnd(), "");
  }

  lines.push(
    "## Context",
    normalizedHints ? "## Hints" : "",
    normalizedHints ? normalizedHints : "",
    normalizedHints ? "" : "",
    prdRefsBlock ? prdRefsBlock : "",
    prdRefsBlock ? "" : "",
    `## Plan (${planLabel})`,
    displayPlan.trimEnd(),
    "",
    seedLabel,
    taskSeedText ? String(taskSeedText).trimEnd() : "",
    taskSeedText ? "" : "",
    "## Rules",
    "- Do not assume functionality is missing; search first.",
    "- No stubs or placeholder implementations.",
    `- Use .loopy/PRD.md and the listed prd_refs before requirement-level decisions.`,
    `- Follow the plan checklist in ${planLabel}.`,
    "- Keep changes focused and maintain repo state.",
    "- Focus on one task at a time. Do not check multiple boxes in a single iteration.",
    "- Mark a task [x] when the implementation is done.",
    "- If a task should be skipped, mark it with [~] or [-] and note the reason.",
    "- If a task is blocked by external factors after 3+ consecutive failures, mark it as [!] with a reason: `[!] task — BLOCKED: reason`. Blocked tasks do not block phase advancement.",
    "- Complete all unchecked tasks in the current phase before tests will be run.",
    "- Run tests in the agent workflow and report them in a ```loopy_test_report``` JSON block.",
    "- If tests fail, fix the failures first.",
    "- If the same task has failed for 3+ consecutive iterations, reassess your approach.",
    "- Record any new guardrails if you detect repetition or drift.",
    "",
    "## Phase Lifecycle",
    "- Phases follow a two-gate lifecycle: Gate 1 = all tasks checked [x] (or skipped [~]/[-] or blocked [!]), Gate 2 = test report status is pass.",
    "- The validation report gate is NOT evaluated until every task in the current phase is checked. Focus on completing tasks first.",
    "- Never cycle back to a previous phase. Phases are sequential and one-directional.",
    "- When completing the last task of a phase, summarize any findings or measurements into `.loopy/hints.md` so the next phase has context. Also review the next phase's tasks and refine them if your work produced information that makes them inaccurate or too vague.",
    "",
    "## Guardrails",
    guardrailsText.trimEnd(),
    ""
  );

  return lines.join("\n");
}

module.exports = {
  formatProgress,
  ensureGuardrails,
  appendSign,
  formatPrompt,
};
