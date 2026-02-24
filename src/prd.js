const { DEFAULTS } = require("./config");
const { runShellCommand } = require("./shell");
const { normalizeTaskSeedText } = require("./text");

const PRD_INSTRUCTIONS = [
  "## Purpose",
  "Create a concise, agent-ready PRD from an ambiguous problem definition. The output is optimized for code agents (clear, structured, unambiguous), not for human narrative.",
  "",
  "## Research First",
  "Before writing the PRD, explore the project to ground your analysis in evidence:",
  "1. Read top-level project files to understand the language, framework, and structure.",
  "2. Search the codebase for files relevant to the problem (use keywords from the seed).",
  "3. Run `git log --oneline -20` to check recent changes that may relate to the problem.",
  "4. If the seed describes a regression or change in behavior, look for recent commits that could have introduced it.",
  "5. If the seed references measurable quantities, check whether they can be measured NOW from available data and include actual values in the PRD.",
  "",
  "## Quick Start",
  "1. Extract the problem statement and summarize it in one sentence.",
  "2. Fill the PRD template below.",
  "3. Ground every claim in evidence from the codebase. Only make assumptions for information that genuinely cannot be determined from the code, configs, logs, or locally available tools. List assumptions explicitly and explain why the evidence is unavailable.",
  "4. Keep it concise (1-2 pages).",
  "",
  "## Clarifying Questions (ask only if critical)",
  "Ask up to 5 concise questions when the ambiguity blocks a requirement or success metric.",
  "- Primary user and environment?",
  "- Core pain point and frequency?",
  "- Must-have outcomes vs nice-to-have?",
  "- Constraints (tech, legal, timeline, budget)?",
  "- Success metrics or KPIs?",
  "",
  "If unanswered, proceed with assumptions and note them.",
  "",
  "## PRD Template (agent-ready)",
  "Use this exact structure and keep bullets short.",
  "",
  "```markdown",
  "# PRD: [Working Title]",
  "",
  "## Problem Statement",
  "[1 sentence]",
  "",
  "## Current Baseline",
  "- [Metric 1]: [current measured value] (source: [tool or method])",
  "- Populate baselines with actual values discovered during research. Only write 'not yet measured' if the data genuinely requires future runtime observation.",
  "",
  "## Goals",
  "- [Goal 1]",
  "- [Goal 2]",
  "",
  "## Non-Goals",
  "- [Explicitly out of scope item]",
  "",
  "## Users & Context",
  "- Primary user: [role + context]",
  "- Secondary user(s): [if any]",
  "- Environment: [web/mobile/internal/etc.]",
  "",
  "## Scope",
  "- In scope: [short bullets]",
  "- Out of scope: [short bullets]",
  "",
  "## Data Sources",
  "- [Source]: [what it provides and how to access it]",
  "- List tools, APIs, logs, or commands that can provide evidence for this problem.",
  "- If no external data sources apply, write \"N/A — problem is self-contained in code.\"",
  "",
  "## Requirements",
  "### Functional",
  "- [F1] ...",
  "- [F2] ...",
  "",
  "### Non-Functional",
  "- [N1] Performance: ...",
  "- [N2] Security/Privacy: ...",
  "- [N3] Accessibility: ...",
  "",
  "## User Stories (MVP)",
  "- As a [user], I want [capability], so that [benefit].",
  "",
  "## Success Metrics",
  "- [Metric 1] ...",
  "- [Metric 2] ...",
  "",
  "## Risks & Mitigations",
  "- [Risk] → [Mitigation]",
  "",
  "## Open Questions",
  "- [Question 1]",
  "",
  "## Assumptions",
  "- [Assumption 1]",
  "```",
  "",
  "## Quality Bar",
  "- Requirements are testable and unambiguous.",
  "- Scope is explicit with clear non-goals.",
  "- Metrics are measurable and time-bounded when possible.",
  "- Assumptions are clearly labeled.",
  "",
  "## Anti-Patterns",
  "- Writing 'Unknown' or 'to be measured' for baselines the agent can determine from the codebase or available tools.",
  "- Framing a problem with identifiable causes as an open-ended investigation.",
  "- Setting relative improvement goals without knowing current absolute values.",
  "- Listing measurement or observability as a primary goal when the actual goal is to fix a problem or deliver a capability.",
  "- Generating a PRD from the seed text alone without exploring the project first.",
].join("\n");

function stripMarkdownFence(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/```(?:markdown)?\s*\n([\s\S]*?)\n```/i);
  if (match) return match[1].trim();
  return trimmed;
}

function buildPrdPrompt(seedText, extraContext) {
  const sections = [PRD_INSTRUCTIONS.trim(), "", "## Source Material", String(seedText || "").trim()];
  if (extraContext) {
    sections.push("", "## Additional Context", String(extraContext || "").trim());
  }
  sections.push("", "Return only the PRD markdown. Do not wrap in code fences or add commentary.");
  return sections.join("\n");
}

async function generatePrdWithAgent(
  agentCommand,
  seedText,
  { extraContext, cwd, noColor, stopSignal, streamToTerminal } = {}
) {
  const cmd = String(agentCommand || "").trim();
  if (!cmd) throw new Error("Missing agent command for PRD generation.");
  const prompt = buildPrdPrompt(seedText, extraContext);
  const result = await runShellCommand(cmd, prompt, DEFAULTS.maxOutputBytes, {
    cwd,
    noColor,
    stopSignal,
    streamToTerminal: Boolean(streamToTerminal),
  });
  if (result.aborted) {
    return { aborted: true, text: "", raw: "" };
  }
  const stdout = normalizeTaskSeedText(result.stdout || "");
  const stderr = normalizeTaskSeedText(result.stderr || "");
  const output = stdout || stderr;
  if (result.code !== 0) {
    const firstLine = (stderr || stdout).split(/\r?\n/).find(Boolean) || "unknown error";
    throw new Error(`PRD generation failed (exit ${result.code}): ${firstLine}`);
  }
  if (!output) throw new Error("PRD generation returned empty output.");
  const cleaned = normalizeTaskSeedText(stripMarkdownFence(output));
  if (!cleaned) throw new Error("PRD generation returned empty output.");
  return { text: cleaned, raw: output, aborted: false };
}

module.exports = {
  generatePrdWithAgent,
};
