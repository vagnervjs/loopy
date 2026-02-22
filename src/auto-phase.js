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

function sanitizeControlChars(text) {
  // Preserve tab/newline/carriage return but drop other control bytes (including ANSI escapes).
  return String(text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
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

function stripYamlFences(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const fenceMatch = raw.match(/```(?:yaml)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return raw;
}

function extractPlanPayloadStrict(stdoutText) {
  const raw = sanitizeControlChars(stdoutText).trim();
  if (!raw) {
    const err = new Error("missing BEGIN_LOOPY_PLAN/END_LOOPY_PLAN markers in stdout");
    err.code = "invalid-plan-envelope";
    throw err;
  }
  const markerRegex = /BEGIN_LOOPY_PLAN\s*([\s\S]*?)\s*END_LOOPY_PLAN/gim;
  const matches = [];
  let match = markerRegex.exec(raw);
  while (match) {
    matches.push(match);
    match = markerRegex.exec(raw);
  }
  if (matches.length !== 1) {
    const err = new Error(
      matches.length === 0
        ? "missing BEGIN_LOOPY_PLAN/END_LOOPY_PLAN markers in stdout"
        : `found ${matches.length} BEGIN_LOOPY_PLAN blocks; expected exactly 1`
    );
    err.code = "invalid-plan-envelope";
    throw err;
  }

  const full = matches[0][0].trim();
  if (full !== raw) {
    const err = new Error("stdout must contain only a single BEGIN_LOOPY_PLAN...END_LOOPY_PLAN block");
    err.code = "invalid-plan-envelope";
    throw err;
  }
  return stripYamlFences(matches[0][1]);
}

function normalizeStopOn(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  if (value == null || value === "") return "all_checked";
  return String(value).trim();
}

function validatePlanSchema(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "root must be a mapping";
  }

  const phaseDefaults = parsed.phase_defaults || parsed.phaseDefaults || {};
  if (phaseDefaults != null && (typeof phaseDefaults !== "object" || Array.isArray(phaseDefaults))) {
    return "phase_defaults must be a mapping";
  }

  const phases = parsed.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    return "phases must be a non-empty array";
  }

  const phaseTasks = parsed.phase_tasks || parsed.phaseTasks;
  if (!phaseTasks || typeof phaseTasks !== "object" || Array.isArray(phaseTasks)) {
    return "phase_tasks must be a mapping";
  }

  const seen = new Set();
  for (let i = 0; i < phases.length; i += 1) {
    const p = phases[i];
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      return `phases[${i}] must be a mapping`;
    }
    const id = toSlug(p.id || p.name || p.key || p.phase || p.title || "") || String(p.id || "").trim();
    if (!id) return `phases[${i}].id is required`;
    if (seen.has(id)) return `phases[${i}].id must be unique (${id})`;
    seen.add(id);

    const title = String(p.title || p.name || id || "").trim();
    if (!title) return `phases[${i}].title is required`;

    const stopOn = normalizeStopOn(p.stop_on != null ? p.stop_on : phaseDefaults.stop_on);
    const stopValues = Array.isArray(stopOn) ? stopOn : [stopOn];
    if (!stopValues.length || stopValues.some((v) => v !== "all_checked" && v !== "tests_pass")) {
      return `phases[${i}].stop_on must be all_checked, tests_pass, or a list of them`;
    }

    const rawTasks = phaseTasks[id];
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return `phase_tasks.${id} must be a non-empty array`;
    }
    for (let j = 0; j < rawTasks.length; j += 1) {
      const item = rawTasks[j];
      if (typeof item !== "string" || !item.trim()) {
        return `phase_tasks.${id}[${j}] must be a non-empty string`;
      }
    }
  }

  return "";
}

async function proposePhasesWithAgent(
  agentCommand,
  seedText,
  { maxOutputBytes = 50000, noColor, stopSignal, streamToTerminal } = {}
) {
  const cmd = String(agentCommand || "").trim();
  if (!cmd) return { ok: false, error: "missing-agent-command", output: "", stdout: "", stderr: "" };

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
    "Output contract: stdout must contain exactly one BEGIN_LOOPY_PLAN...END_LOOPY_PLAN block and nothing else.",
    "Send any diagnostics or logs to stderr only.",
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
    "- Start with a strong verb: add / implement / update / remove / verify / investigate / measure / analyze.",
    "- Before planning, explore the codebase to understand its structure, key files, and existing patterns. Ground your tasks in what you find.",
    "- Reference actual file paths, function names, or config keys in task descriptions when discoverable.",
    "- Use 2-8 tasks per phase, sized to actual work. Do NOT pad to reach a minimum count.",
    "- Ensure phase_defaults.test_command is set (ask if unsure).",
    "- Quote every checklist item in YAML.",
    "",
    "DISCOVERY PHASES:",
    "When the problem requires understanding WHY something is happening before deciding WHAT to change, include a discovery phase before implementation.",
    "This applies broadly: performance issues, unexpected behavior, system migrations, dependency upgrades, infrastructure changes, data inconsistencies, or any situation where the right fix is not obvious from the problem statement alone.",
    "",
    "Discovery phase rules:",
    "- Tasks use investigate / measure / analyze verbs.",
    "- Each task specifies: what question to answer, what data source or tool to use, and what artifact to produce.",
    "- Findings from discovery ground the implementation tasks -- later phases should reference what was learned.",
    "- Discovery tasks are non-code: they read, query, compare, and document. They do NOT edit source files.",
    "- A discovery phase uses stop_on: all_checked (no test_command needed).",
    "",
    "GOOD discovery tasks (specific tool, clear output):",
    "- 'investigate: query CI API for job durations over last 14 days, identify trend changes, correlate with git history — Acceptance: documented finding with pre/post comparison'",
    "- 'measure: profile build step wall-clock time with and without cache, compare output sizes — Acceptance: table of timings and sizes for each variant'",
    "- 'analyze: diff dependency tree before and after upgrade using npm ls, identify new transitive dependencies — Acceptance: list of added packages with sizes'",
    "",
    "BAD discovery tasks (vague, no tool, no output):",
    "- 'investigate: understand why the system is slow'",
    "- 'analyze: look into the problem'",
    "- 'research: figure out root cause'",
    "",
    "When NOT to include a discovery phase:",
    "- The problem statement already contains the root cause and the fix is known.",
    "- The task is additive (new feature, new file, new test) with no diagnostic ambiguity.",
    "- The scope is a straightforward refactor with clear before/after.",
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
  const stdout = sanitizeControlChars(result.stdout || "");
  const stderr = sanitizeControlChars(result.stderr || "");
  if (result.aborted) {
    return { ok: false, aborted: true, error: "aborted", output: "", stdout, stderr };
  }
  const output = stdout.trim();
  if (result.code !== 0) {
    return { ok: false, error: `agent-exit-${result.code}`, output, stdout, stderr };
  }

  let payload = "";
  try {
    payload = extractPlanPayloadStrict(stdout);
  } catch (err) {
    const msg = err && err.message ? err.message : "invalid-plan-envelope";
    return { ok: false, error: `invalid-plan-envelope: ${msg}`, output, stdout, stderr };
  }

  let parsed = null;
  try {
    parsed = yaml.load(payload) || {};
  } catch (err) {
    const msg = err && err.message ? err.message : "invalid-yaml";
    return { ok: false, error: `invalid-yaml: ${msg}`, output: payload, stdout, stderr };
  }

  const schemaError = validatePlanSchema(parsed);
  if (schemaError) {
    return { ok: false, error: `invalid-plan-schema: ${schemaError}`, output: payload, stdout, stderr };
  }

  const normalized = normalizePhaseOutput(parsed);
  if (!normalized.phases.length) {
    return { ok: false, error: "no-phases", output: payload, stdout, stderr };
  }
  const anyTasks = normalized.phases.some((p) => (normalized.tasksByPhase[p.id] || []).length > 0);
  if (!anyTasks) {
    return { ok: false, error: "no-phase-tasks", output: payload, stdout, stderr };
  }

  return { ok: true, ...normalized, output: payload, stdout, stderr };
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
  sanitizeControlChars,
  extractPlanPayloadStrict,
  validatePlanSchema,
};
