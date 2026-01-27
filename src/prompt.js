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
    `## Plan (${planLabel})`,
    taskText.trimEnd(),
    "",
    "## Guardrails",
    guardrailsText.trimEnd(),
    "",
    "## Progress",
    progressText.trimEnd(),
  ];

  if (!rotationPending && lastOutput) {
    lines.push("", "## Last Agent Output (truncated)", lastOutput.trimEnd());
  }

  lines.push(
    "",
    "## Instructions",
    `- Follow the plan checklist in ${planLabel}.`,
    "- Update plan checkboxes as you complete items.",
    "- Record any new guardrails if you detect repetition or drift.",
    "- Keep changes focused and maintain repo state.",
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
