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

  const counts = Object.values(tasksByPhase).map((t) => t.length);
  const allSame = counts.length > 1 && counts.every((c) => c === counts[0]);
  const anyOversize = counts.some((c) => c > 8);
  if (allSame && counts[0] > 3) {
    console.warn(`[loopy] Warning: all ${counts.length} phases have exactly ${counts[0]} tasks -- plan may be formulaic.`);
  }
  if (anyOversize) {
    console.warn(`[loopy] Warning: phase has ${Math.max(...counts)} tasks (>8) -- consider splitting.`);
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
    plan: [
      seed
        ? `Plan: [needs refinement] ${seed} — Acceptance: outline scope and milestones`
        : "Plan: [needs refinement] Clarify requirements and outline approach — Acceptance: outline scope and milestones",
    ],
    implement: [
      seed
        ? `Implement: [needs refinement] ${seed} — Acceptance: behavior matches requirements`
        : "Implement: [needs refinement] Apply the requested changes — Acceptance: behavior matches requirements",
    ],
    verify: [
      tc
        ? `Verify: [needs refinement] Run tests (${tc}) — Acceptance: test suite passes`
        : "Verify: [needs refinement] Validate behavior and edge cases — Acceptance: expected behavior confirmed",
    ],
  };
  return { phases, phaseDefaults: { stop_on: "all_checked", test_command: tc }, tasksByPhase };
}

async function proposePhasesWithAgent(
  agentCommand,
  seedText,
  { maxOutputBytes = 50000, noColor, stopSignal, streamToTerminal } = {}
) {
  const cmd = String(agentCommand || "").trim();
  if (!cmd) return { ok: false, error: "missing-agent-command", output: "" };

  const prompt = [
    "You are Loopy's planning assistant.",
    "Given a task description, propose a phase plan.",
    "",
    "Return ONLY valid YAML wrapped between these exact markers (no extra text before/after):",
    "BEGIN_LOOPY_PLAN",
    "<YAML>",
    "END_LOOPY_PLAN",
    "Do NOT include markdown fences (```), headings, or commentary.",
    "If you add any extra text, the plan will be rejected.",
    "",
    "YAML schema:",
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
    "    - \"<checklist item text>\"",
    "",
    "Break work into tasks that an AI code agent can execute in a single session:",
    "- Specific: say HOW, not just WHAT. Name the file, function, config key, or mechanism when known.",
    "- Atomic: exactly ONE outcome per task (no compound items).",
    "- Testable: include explicit acceptance criteria that can be verified programmatically or by inspecting output.",
    "- Scoped: small enough for < 1 day of work.",
    "- Executable: every task must be completable by a code agent (read/search/edit files, run commands). Exclude tasks requiring human judgment over time, multi-day monitoring, or manual approval gates.",
    "- Format: \"<type>: <short summary> — Acceptance: <clear test/result>\"",
    "- Start with a strong verb: add / implement / update / remove / verify.",
    "- Before planning, explore the codebase to understand its structure, key files, and existing patterns. Ground your tasks in what you find.",
    "- Reference actual file paths, function names, or config keys in task descriptions when discoverable.",
    "- Use 2-8 tasks per phase, sized to actual work. Do NOT pad to reach a minimum count.",
    "- Ensure phase_defaults.test_command is set (ask if unsure).",
    "- Quote every checklist item in YAML.",
    "",
    "BAD task: 'implement: optimize the data pipeline' (vague, no mechanism, no target file).",
    "GOOD task: 'implement: add Redis caching to `src/services/user-service.ts` getUser() — Acceptance: cache-hit path returns in <10ms in test.'",
    "",
    "Keep phases small (2-5). Prefer stable ids. Ensure every phase has at least 1 checklist item.",
    "",
    `Task:\n${String(seedText || "").trim()}`,
    "",
  ].join("\n");

  const shellOptions = {};
  if (noColor !== undefined) shellOptions.noColor = noColor;
  if (stopSignal) shellOptions.stopSignal = stopSignal;
  shellOptions.streamToTerminal = Boolean(streamToTerminal);
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
    output = normalizePlannerYaml(output);
    parsed = yaml.load(output) || {};
  } catch (err) {
    try {
      const recovered = quotePhaseTasks(output);
      parsed = yaml.load(recovered) || {};
      output = recovered;
    } catch (err2) {
      const msg = err && err.message ? err.message : "invalid-yaml";
      return { ok: false, error: `invalid-yaml: ${msg}`, output };
    }
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

function normalizePlannerYaml(text) {
  let raw = stripYamlFences(text);
  if (!raw) return raw;

  const marker = raw.match(/BEGIN_LOOPY_PLAN\s*([\s\S]*?)\s*END_LOOPY_PLAN/i);
  if (marker) {
    raw = marker[1].trim();
  }

  const yamlStart = raw.search(/(^|\n)phase_defaults:\s*/);
  if (yamlStart >= 0) {
    raw = raw.slice(yamlStart).trim();
  }

  const cutoff = raw.search(/\nTotal usage|\nAPI time spent|\nBreakdown by AI model|\nTotal session time/);
  if (cutoff >= 0) {
    raw = raw.slice(0, cutoff).trim();
  }

  return raw.trim();
}

function quotePhaseTasks(text) {
  const lines = String(text || "").split(/\r?\n/);
  let inPhaseTasks = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*phase_tasks:\s*$/.test(line)) {
      inPhaseTasks = true;
      continue;
    }
    if (inPhaseTasks && /^\S/.test(line)) {
      inPhaseTasks = false;
    }
    if (!inPhaseTasks) continue;

    const match = line.match(/^(\s*-\s+)(.+)$/);
    if (!match) continue;
    const prefix = match[1];
    const value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) continue;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines[i] = `${prefix}"${escaped}"`;
  }
  return lines.join("\n");
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
