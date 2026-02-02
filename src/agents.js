const path = require("path");

const { runShellCommand } = require("./shell");
const { DEFAULTS } = require("./config");
const { normalizeTaskSeedText } = require("./text");

const AGENTS_INSTRUCTIONS = [
  "You are creating AGENTS.md for this repository.",
  "Review the repository to identify how to build, test, lint, and run the project.",
  "If you are not confident about a command, omit it.",
  "Keep the file short and operational (no progress notes).",
  "Include only what is necessary for running and validating the project.",
  "",
  "Use this exact structure:",
  "# AGENTS",
  "",
  "## Build & Run",
  "- <commands or notes>",
  "",
  "## Validation",
  "- Tests: <command if confident>",
  "- Lint: <command if confident>",
  "- Typecheck: <command if confident>",
  "",
  "## Operational Notes",
  "- <short notes if needed>",
  "",
  "Return only the AGENTS.md markdown.",
].join("\n");

const AGENTS_STUB = [
  "# AGENTS",
  "",
  "## Build & Run",
  "- (add commands when known)",
  "",
  "## Validation",
  "- Tests: (add command when known)",
  "- Lint: (add command when known)",
  "- Typecheck: (add command when known)",
  "",
  "## Operational Notes",
  "- (add notes when needed)",
  "",
].join("\n");

function stripMarkdownFence(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/```(?:markdown)?\s*\n([\s\S]*?)\n```/i);
  if (match) return match[1].trim();
  return trimmed;
}

function buildAgentsPrompt() {
  return AGENTS_INSTRUCTIONS.trim();
}

async function generateAgentsWithAgent(agentCommand, { cwd, noColor, stopSignal } = {}) {
  const cmd = String(agentCommand || "").trim();
  if (!cmd) throw new Error("Missing agent command for AGENTS generation.");
  const prompt = buildAgentsPrompt();
  const result = await runShellCommand(cmd, prompt, DEFAULTS.maxOutputBytes, { cwd, noColor, stopSignal });
  if (result.aborted) {
    return { aborted: true, text: "", raw: "" };
  }
  const stdout = normalizeTaskSeedText(result.stdout || "");
  const stderr = normalizeTaskSeedText(result.stderr || "");
  const output = stdout || stderr;
  if (result.code !== 0) {
    const firstLine = (stderr || stdout).split(/\r?\n/).find(Boolean) || "unknown error";
    throw new Error(`AGENTS generation failed (exit ${result.code}): ${firstLine}`);
  }
  if (!output) throw new Error("AGENTS generation returned empty output.");
  const cleaned = normalizeTaskSeedText(stripMarkdownFence(output));
  if (!cleaned) throw new Error("AGENTS generation returned empty output.");
  return { text: cleaned, raw: output, aborted: false };
}

function resolveAgentsPath(baseDir) {
  return path.join(baseDir, "AGENTS.md");
}

module.exports = {
  generateAgentsWithAgent,
  buildAgentsStub: () => AGENTS_STUB,
  resolveAgentsPath,
};
