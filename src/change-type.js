const { runShellCommand } = require("./shell");

function extractChangeType(text) {
  if (!text) return { changeType: "chore", summary: "task update" };
  const match = text.match(/^([a-zA-Z]+)\s*:\s*(.+)$/);
  if (!match) return { changeType: "chore", summary: text.trim() };
  const changeType = match[1].toLowerCase();
  const summary = match[2].trim();
  return { changeType, summary: summary || "task update" };
}

function inferChangeTypeHeuristic(text) {
  const raw = (text || "").toLowerCase();
  if (/(docs|readme|documentation|guide)/.test(raw)) return "docs";
  if (/(test|testing|spec|coverage)/.test(raw)) return "test";
  if (/(fix|bug|defect|error|issue|crash)/.test(raw)) return "fix";
  if (/(refactor|cleanup|restructure|simplify)/.test(raw)) return "refactor";
  if (/(perf|performance|optimi[sz]e)/.test(raw)) return "perf";
  if (/(style|format|lint)/.test(raw)) return "style";
  if (/(build|deps|dependency|package)/.test(raw)) return "build";
  if (/(ci|pipeline|workflow|github actions)/.test(raw)) return "ci";
  if (/(chore|maintenance)/.test(raw)) return "chore";
  return "feat";
}

async function inferChangeTypeFromAgent(command, taskLine) {
  if (!command || !taskLine) return "";
  const prompt = [
    "You are a commit message classifier.",
    "Return exactly one word from this list:",
    "feat, fix, docs, test, refactor, chore, perf, style, build, ci",
    "",
    `Task: ${taskLine}`,
  ].join("\n");

  const result = await runShellCommand(command, prompt, 2000, {});
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim().toLowerCase();
  const token = output.split(/\s+/).find(Boolean) || "";
  const allowed = new Set([
    "feat",
    "fix",
    "docs",
    "test",
    "refactor",
    "chore",
    "perf",
    "style",
    "build",
    "ci",
  ]);
  return allowed.has(token) ? token : "";
}

module.exports = {
  extractChangeType,
  inferChangeTypeHeuristic,
  inferChangeTypeFromAgent,
};
