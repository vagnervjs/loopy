const yaml = require("js-yaml");

const { runShellCommand } = require("./shell");
const { toSlug } = require("./task");

function normalizePhaseOutput(parsed) {
  const phaseDefaults = parsed && (parsed.phase_defaults || parsed.phaseDefaults || {}) ? parsed.phase_defaults || parsed.phaseDefaults : {};
  const phasesRaw = parsed && parsed.phases ? parsed.phases : [];
  const phaseTasks = parsed && (parsed.phase_tasks || parsed.phaseTasks) ? parsed.phase_tasks || parsed.phaseTasks : {};

  const phases = Array.isArray(phasesRaw) ? phasesRaw : [];
  const out = [];
  for (const p of phases) {
    if (!p) continue;
    if (typeof p === "string") {
      const title = p.trim();
      const id = toSlug(title) || title;
      if (!id) continue;
      out.push({
        id,
        title: title || id,
        stop_on: phaseDefaults.stop_on || "all_checked",
        test_command: phaseDefaults.test_command || "",
      });
    } else if (typeof p === "object") {
      const id = toSlug(p.id || p.name || p.key || p.phase || p.title || "") || String(p.id || "").trim();
      if (!id) continue;
      out.push({
        id,
        title: String(p.title || p.name || id).trim() || id,
        stop_on: p.stop_on || phaseDefaults.stop_on || "all_checked",
        test_command: p.test_command || phaseDefaults.test_command || "",
      });
    }
  }

  const tasksByPhase = {};
  for (const phase of out) {
    const key = phase.id;
    const raw = phaseTasks[key] || phaseTasks[String(key)] || [];
    const items = Array.isArray(raw) ? raw : [];
    tasksByPhase[key] = items.map((t) => String(t || "").trim()).filter(Boolean);
  }

  return {
    phaseDefaults,
    phases: out,
    tasksByPhase,
  };
}

function fallbackPhasesFromSeed(seedText, { testCommand } = {}) {
  const seed = String(seedText || "").trim();
  const tc = String(testCommand || "").trim();
  const phases = [
    { id: "plan", title: "Plan", stop_on: "all_checked", test_command: "" },
    { id: "implement", title: "Implement", stop_on: "all_checked", test_command: "" },
    { id: "verify", title: "Verify", stop_on: tc ? ["all_checked", "tests_pass"] : "all_checked", test_command: tc },
  ];
  const tasksByPhase = {
    plan: [seed || "Clarify requirements and outline approach."],
    implement: [seed ? `Implement: ${seed}` : "Implement the requested changes."],
    verify: [tc ? `Run tests: ${tc}` : "Validate behavior and edge cases."],
  };
  return { phases, phaseDefaults: { stop_on: "all_checked", test_command: tc }, tasksByPhase };
}

async function proposePhasesWithAgent(agentCommand, seedText, { maxOutputBytes = 50000, noColor, stopSignal } = {}) {
  const cmd = String(agentCommand || "").trim();
  if (!cmd) return { ok: false, error: "missing-agent-command", output: "" };

  const prompt = [
    "You are Loopy's planning assistant.",
    "Given a task description, propose a phase plan.",
    "",
    "Return ONLY valid YAML (no code fences, no extra text) with this schema:",
    "Do NOT include markdown fences (```), headings, or commentary.",
    "If you add any extra text, the plan will be rejected.",
    "phase_defaults:",
    "  stop_on: all_checked",
    "  test_command: <optional>",
    "phases:",
    "  - id: <kebab-case id>",
    "    title: <short title>",
    "    stop_on: <all_checked | tests_pass | [..]>",
    "    test_command: <optional>",
    "phase_tasks:",
    "  <phase id>:",
    "    - <checklist item text>",
    "",
    "Break work into JIRA-sized tasks (as if assigning to a junior engineer):",
    "- Atomic: exactly ONE outcome per task (no compound items).",
    "- Testable: include explicit acceptance criteria.",
    "- Scoped: small enough for < 1 day of work.",
    "- Clear: start with a strong verb (add/implement/update/remove/verify).",
    "- Format: \"<type>: <short summary> — Acceptance: <clear test/result>\"",
    "- Prefer 5-10 tasks per phase.",
    "",
    "Keep phases small (3-6). Prefer stable ids. Ensure every phase has at least 1 checklist item.",
    "",
    `Task:\n${String(seedText || "").trim()}`,
    "",
  ].join("\n");

  const shellOptions = {};
  if (noColor !== undefined) shellOptions.noColor = noColor;
  if (stopSignal) shellOptions.stopSignal = stopSignal;
  const result = await runShellCommand(cmd, prompt, maxOutputBytes, shellOptions);
  if (result.aborted) {
    return { ok: false, aborted: true, error: "aborted", output: "" };
  }
  let output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.code !== 0) {
    return { ok: false, error: `agent-exit-${result.code}`, output };
  }

  let parsed = null;
  try {
    output = stripYamlFences(output);
    parsed = yaml.load(output) || {};
  } catch (err) {
    return { ok: false, error: "invalid-yaml", output };
  }

  const normalized = normalizePhaseOutput(parsed);
  if (!normalized.phases.length) {
    return { ok: false, error: "no-phases", output };
  }
  const anyTasks = normalized.phases.some((p) => (normalized.tasksByPhase[p.id] || []).length > 0);
  if (!anyTasks) {
    return { ok: false, error: "no-phase-tasks", output };
  }

  return { ok: true, ...normalized, output };
}

function stripYamlFences(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const fenceMatch = raw.match(/```(?:yaml)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return raw;
}

function renderTaskMarkdown({
  frontMatter,
  phaseDefaults,
  phases,
  tasksByPhase,
  includeSeedComment = false,
  seedText = "",
} = {}) {
  const fm = { ...(frontMatter || {}) };
  if (phaseDefaults && Object.keys(phaseDefaults).length) fm.phase_defaults = phaseDefaults;
  if (phases && phases.length) {
    fm.phases = phases.map((p) => {
      const entry = { id: p.id, title: p.title };
      if (p.stop_on) entry.stop_on = p.stop_on;
      if (p.test_command) entry.test_command = p.test_command;
      return entry;
    });
  }

  const yamlText = yaml.dump(fm, { lineWidth: 120 }).trimEnd();

  const lines = ["---", yamlText, "---", "", "# Plan", ""];
  if (includeSeedComment && seedText) {
    lines.push(`<!-- loopy:seed ${String(seedText).replace(/-->/g, "--&gt;")} -->`, "");
  }
  for (const phase of phases || []) {
    lines.push(`## Phase: ${phase.id}`, `<!-- loopy:phase ${phase.id} -->`, "");
    const items = (tasksByPhase && tasksByPhase[phase.id]) || [];
    const usable = items.length ? items : [`Complete phase: ${phase.title || phase.id}`];
    for (const item of usable) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = {
  proposePhasesWithAgent,
  fallbackPhasesFromSeed,
  renderTaskMarkdown,
};
