const path = require("path");

const { appendActivity } = require("../activity");
const { prettyPath } = require("../config");
const { readText, writeText } = require("../fs");
const { generateAgentsWithAgent, buildAgentsStub, resolveAgentsPath } = require("../agents");
const { printStep } = require("../steps");
const { redact } = require("../text");

async function writeAgentsDoc(config, { preferredPath, fallbackPath, text, label }) {
  const payload = `${text.trimEnd()}\n`;
  try {
    await writeText(preferredPath, payload);
    await appendActivity(config.activityLog, [
      `${label}: ${prettyPath(config.cwd, preferredPath)}`,
    ]);
    printStep(`AGENTS saved to ${prettyPath(config.cwd, preferredPath)}`, { kind: "plan" });
    return preferredPath;
  } catch (err) {
    if (!fallbackPath) throw err;
    await writeText(fallbackPath, payload);
    await appendActivity(config.activityLog, [
      `${label}: ${prettyPath(config.cwd, fallbackPath)}`,
    ]);
    printStep(`AGENTS saved to ${prettyPath(config.cwd, fallbackPath)}`, { kind: "plan" });
    return fallbackPath;
  }
}

async function ensureAgentsDoc(config, { stopSignal } = {}) {
  const cwd = config.cwd;
  const rootPath = resolveAgentsPath(cwd);
  const loopyPath = resolveAgentsPath(config.loopyDir || path.join(cwd, ".loopy"));

  const rootText = await readText(rootPath);
  if (String(rootText || "").trim()) {
    return { text: rootText, path: rootPath, source: "root" };
  }

  const loopyText = await readText(loopyPath);
  if (String(loopyText || "").trim()) {
    return { text: loopyText, path: loopyPath, source: "loopy" };
  }

  if (!config.bootstrapAgents) {
    return { text: "", path: "", source: "" };
  }

  if (!process.stdin.isTTY) {
    const stub = buildAgentsStub();
    const savedPath = await writeAgentsDoc(config, {
      preferredPath: rootPath,
      fallbackPath: loopyPath,
      text: stub,
      label: "AGENTS stub generated (non-interactive)",
    });
    return {
      text: stub,
      path: savedPath,
      source: savedPath === rootPath ? "root" : "loopy",
    };
  }

  const agentLabel = config.agentCommand ? ` with ${redact(config.agentCommand)}` : "";
  printStep(`Generating AGENTS.md${agentLabel}`, { kind: "plan" });
  let agentsText = "";
  try {
    const result = await generateAgentsWithAgent(config.agentCommand, {
      cwd,
      noColor: config.noColor,
      stopSignal,
    });
    if (result.aborted || (stopSignal && stopSignal.stopRequested)) {
      return { text: "", path: "", source: "aborted" };
    }
    agentsText = result.text || "";
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await appendActivity(config.activityLog, [`AGENTS bootstrap failed: ${message}`]);
    agentsText = buildAgentsStub();
  }
  if (!String(agentsText || "").trim()) {
    agentsText = buildAgentsStub();
  }
  const savedPath = await writeAgentsDoc(config, {
    preferredPath: rootPath,
    fallbackPath: loopyPath,
    text: agentsText,
    label: "AGENTS generated",
  });
  return {
    text: agentsText,
    path: savedPath,
    source: savedPath === rootPath ? "bootstrapped-root" : "bootstrapped-loopy",
  };
}

module.exports = {
  ensureAgentsDoc,
};
