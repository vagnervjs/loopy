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
  agentsText,
  specsText,
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
  const agentsBlock = String(agentsText || "").trim() ? ["## AGENTS", String(agentsText || "").trimEnd()].join("\n") : "";
  const specsBlock = String(specsText || "").trim()
    ? ["## Specs Summary", String(specsText || "").trimEnd()].join("\n")
    : "";
  const instructionsLines = ["## Instructions"];
  instructionsLines.push(
    "- Don't assume something is unimplemented; search first.",
    currentTask ? null : "- Complete only the current task.",
    "- Update AGENTS.md only for operational learnings.",
    "- No stubs or placeholder implementations.",
    `- Follow the plan checklist in ${planLabel}.`,
    "- Update plan checkboxes as you complete items.",
    "- Record any new guardrails if you detect repetition or drift.",
    "- Keep changes focused and maintain repo state.",
    "- Do NOT mark a task checkbox as [x] unless the full test command passes.",
    "- Always run the plan's test_command to validate your work.",
    "- If tests fail, leave the checkbox unchecked and fix the failures first.",
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
      current_task: currentTask || "",
      current_task_block: currentTaskBlock,
      guardrails: String(guardrailsText || "").trimEnd(),
      progress: String(progressText || "").trimEnd(),
      last_output: String(lastOutput || "").trimEnd(),
      last_output_block: lastOutputBlock,
      agents: String(agentsText || "").trimEnd(),
      agents_block: agentsBlock,
      specs: String(specsText || "").trimEnd(),
      specs_block: specsBlock,
      instructions: instructionsBlock,
    };
    const rendered = applyPromptTemplate(templateText, tokens);
    if (rendered.trim()) return rendered;
  }

  const lines = [
    "# Loopy Loop Prompt",
    "",
    `Timestamp: ${new Date().toISOString()}`,
    `Iteration: ${iteration}`,
    `Rotation: ${rotationPending ? "fresh" : "standard"}`,
    currentPhase ? `Phase: ${currentPhase}` : "",
    "",
    seedLabel,
    taskSeedText ? String(taskSeedText).trimEnd() : "",
    taskSeedText ? "" : "",
    normalizedHints ? "## Hints" : "",
    normalizedHints ? normalizedHints : "",
    normalizedHints ? "" : "",
    String(specsText || "").trim() ? "## Specs Summary" : "",
    String(specsText || "").trim() ? String(specsText).trimEnd() : "",
    String(specsText || "").trim() ? "" : "",
    String(agentsText || "").trim() ? "## AGENTS" : "",
    String(agentsText || "").trim() ? String(agentsText).trimEnd() : "",
    String(agentsText || "").trim() ? "" : "",
  ];

  if (currentTask) {
    lines.push(
      "## Current Task",
      "",
      `- [ ] ${currentTask}`,
      ""
    );
  }

  lines.push(
    `## Plan (${planLabel})`,
    displayPlan.trimEnd(),
    "",
    "## Guardrails",
    guardrailsText.trimEnd(),
    "",
    "## Progress",
    progressText.trimEnd()
  );

  if (!rotationPending && lastOutput) {
    lines.push("", "## Last Agent Output (truncated)", lastOutput.trimEnd());
  }

  lines.push(
    "",
    "## Instructions"
  );

  if (currentTask) {
    lines.push("- **Complete only the Current Task in this iteration.**");
  }

  lines.push(
    `- Follow the plan checklist in ${planLabel}.`,
    "- Update plan checkboxes as you complete items.",
    "- Record any new guardrails if you detect repetition or drift.",
    "- Keep changes focused and maintain repo state.",
    "- Do NOT mark a task checkbox as [x] unless the full test command passes.",
    "- Always run the plan's test_command to validate your work.",
    "- If tests fail, leave the checkbox unchecked and fix the failures first.",
    "- If the same task has failed for 3+ consecutive iterations, reassess your approach.",
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
