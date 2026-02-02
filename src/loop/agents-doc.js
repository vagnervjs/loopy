const path = require("path");

const { appendActivity } = require("../activity");
const { prettyPath } = require("../config");
const { readText, writeText } = require("../fs");
const { generateAgentsWithAgent, buildAgentsStub, resolveAgentsPath } = require("../agents");
const { printStep } = require("../steps");
const { redact } = require("../text");

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
    const payload = `${stub.trimEnd()}\n`;
    await writeText(loopyPath, payload);
    await appendActivity(config.activityLog, [
      `AGENTS stub generated (non-interactive): ${prettyPath(config.cwd, loopyPath)}`,
    ]);
    printStep(`AGENTS saved to ${prettyPath(config.cwd, loopyPath)}`, { kind: "plan" });
    return { text: stub, path: loopyPath, source: "stub" };
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
  const payload = `${agentsText.trimEnd()}\n`;
  await writeText(loopyPath, payload);
  await appendActivity(config.activityLog, [
    `AGENTS generated: ${prettyPath(config.cwd, loopyPath)}`,
  ]);
  printStep(`AGENTS saved to ${prettyPath(config.cwd, loopyPath)}`, { kind: "plan" });
  return { text: agentsText, path: loopyPath, source: "bootstrapped" };
}

module.exports = {
  ensureAgentsDoc,
};
