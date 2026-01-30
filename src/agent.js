const fs = require("fs/promises");
const nodeFs = require("fs");
const path = require("path");

const KNOWN_AGENT_COMMANDS = [
  "cursor-agent",
  "aider",
  "claude",
  "copilot",
  "codex",
  "opencode",
  "openai",
  "gemini",
  "llm",
  "cody",
  "continue",
];

function normalizeAgentCommand(value) {
  return String(value || "").trim();
}

function splitPathEntries(value) {
  const raw = String(value || "");
  return raw
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"+|"+$/g, "").trim())
    .filter(Boolean);
}

function candidateExtensions(command) {
  if (process.platform !== "win32") return [""];
  if (path.extname(command)) return [""];
  const pathext = process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM";
  return pathext
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
}

async function isExecutable(filePath) {
  try {
    if (process.platform === "win32") {
      await fs.access(filePath, nodeFs.constants.F_OK);
    } else {
      await fs.access(filePath, nodeFs.constants.X_OK);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function isCommandAvailable(command) {
  const normalized = normalizeAgentCommand(command);
  if (!normalized) return false;
  const hasSeparator = normalized.includes(path.sep) || (process.platform === "win32" && normalized.includes("/"));
  const extensions = candidateExtensions(normalized);
  const candidates = extensions.map((ext) => (ext ? `${normalized}${ext}` : normalized));

  if (hasSeparator) {
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) return true;
    }
    return false;
  }

  const pathValue = process.env.PATH || process.env.Path || "";
  const pathEntries = splitPathEntries(pathValue);
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const full = path.join(entry, candidate);
      if (await isExecutable(full)) return true;
    }
  }
  return false;
}

async function detectAvailableAgents(candidates = KNOWN_AGENT_COMMANDS) {
  const list = Array.isArray(candidates) ? candidates : KNOWN_AGENT_COMMANDS;
  const seen = new Set();
  const available = [];
  for (const candidate of list) {
    const cmd = normalizeAgentCommand(candidate);
    if (!cmd || seen.has(cmd)) continue;
    if (await isCommandAvailable(cmd)) {
      available.push(cmd);
      seen.add(cmd);
    }
  }
  return available;
}

function buildAgentChoiceOptions(availableAgents, defaultCommand, { includeCustom = true } = {}) {
  const options = [];
  const normalizedDefault = normalizeAgentCommand(defaultCommand);
  const available = Array.isArray(availableAgents) ? availableAgents : [];
  const deduped = [];
  const seen = new Set();
  for (const cmd of available) {
    const normalized = normalizeAgentCommand(cmd);
    if (!normalized || seen.has(normalized)) continue;
    deduped.push(normalized);
    seen.add(normalized);
  }

  if (normalizedDefault && !seen.has(normalizedDefault)) {
    options.push({ label: `${normalizedDefault} (configured)`, value: normalizedDefault });
  }

  for (const cmd of deduped) {
    options.push({ label: cmd, value: cmd });
  }

  if (includeCustom) {
    options.push({ label: "Other (enter custom command)", value: "__custom__" });
  }

  return { options, defaultValue: normalizedDefault };
}

module.exports = {
  KNOWN_AGENT_COMMANDS,
  buildAgentChoiceOptions,
  detectAvailableAgents,
};
