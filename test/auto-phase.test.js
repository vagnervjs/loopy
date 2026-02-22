const assert = require("node:assert/strict");

const { suite } = require("./suite");
const { extractPlanPayloadStrict, proposePhasesWithAgent, sanitizeControlChars, validatePlanSchema } = require("../src/auto-phase");

const test = suite("auto-phase");

function baseYaml() {
  return [
    "phase_defaults:",
    "  stop_on: all_checked",
    "  test_command: node -e \"process.exit(0)\"",
    "phases:",
    "  - id: build",
    "    title: Build",
    "phase_tasks:",
    "  build:",
    "    - \"implement: update src/index.js — Acceptance: tests pass\"",
    "",
  ].join("\n");
}

function nodeEval(script) {
  return `node -e ${JSON.stringify(String(script || ""))}`;
}

test("extractPlanPayloadStrict requires exactly one envelope with no extra stdout text", async () => {
  const yaml = baseYaml();
  const payload = extractPlanPayloadStrict(`BEGIN_LOOPY_PLAN\n${yaml}\nEND_LOOPY_PLAN`);
  assert.equal(payload.trim(), yaml.trim());

  assert.throws(
    () => extractPlanPayloadStrict(`noise\nBEGIN_LOOPY_PLAN\n${yaml}\nEND_LOOPY_PLAN`),
    /stdout must contain only a single BEGIN_LOOPY_PLAN/
  );
  assert.throws(() => extractPlanPayloadStrict(yaml), /missing BEGIN_LOOPY_PLAN/);
});

test("proposePhasesWithAgent parses from stdout only and ignores stderr chatter", async () => {
  const yaml = baseYaml().replace("Build", "Compile");
  const yamlJson = JSON.stringify(yaml);
  const cmd = nodeEval(
    `const yaml = ${yamlJson};` +
      'process.stdout.write("BEGIN_LOOPY_PLAN\\n" + yaml + "\\nEND_LOOPY_PLAN");' +
      'process.stderr.write("mcp: starting\\nphase_defaults: nope\\n");'
  );
  const result = await proposePhasesWithAgent(cmd, "seed");
  assert.equal(result.ok, true, result.error || "");
  assert.equal(result.phases[0].id, "build");
  assert.equal(result.phases[0].title, "Compile");
});

test("proposePhasesWithAgent rejects missing envelope", async () => {
  const cmd = nodeEval(`process.stdout.write(${JSON.stringify(baseYaml())})`);
  const result = await proposePhasesWithAgent(cmd, "seed");
  assert.equal(result.ok, false);
  assert.match(result.error, /^invalid-plan-envelope:/);
});

test("proposePhasesWithAgent rejects invalid yaml inside envelope", async () => {
  const badYaml = "phase_defaults:\n  stop_on: all_checked\n  broken: [\n";
  const cmd = nodeEval(`process.stdout.write("BEGIN_LOOPY_PLAN\\n${badYaml.replace(/\n/g, "\\n")}END_LOOPY_PLAN")`);
  const result = await proposePhasesWithAgent(cmd, "seed");
  assert.equal(result.ok, false);
  assert.match(result.error, /^invalid-yaml:/);
});

test("validatePlanSchema rejects malformed plan structures", async () => {
  const err = validatePlanSchema({
    phase_defaults: { stop_on: "all_checked" },
    phases: [{ id: "build", title: "Build" }],
    phase_tasks: { build: [] },
  });
  assert.match(err, /phase_tasks\.build must be a non-empty array/);
});

test("sanitizeControlChars removes non-printable bytes", async () => {
  const text = "abc\u001b[31mred\u0007ok";
  assert.equal(sanitizeControlChars(text), "abc[31mredok");
});
