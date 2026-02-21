const { suite } = require("./suite");
const test = suite("prd-refs-enforcement");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { parseTask } = require("../src/task");
const { enforcePrdRefsCoverage } = require("../src/loop/plan-ensure");

test("enforcePrdRefsCoverage auto-adds prd_refs_defaults for implementation tasks", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-prd-refs-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const taskFile = path.join(loopyDir, "LOOPY_PLAN.md");
  const prdFile = path.join(loopyDir, "PRD.md");

  await fs.writeFile(
    taskFile,
    [
      "---",
      'agent_command: "node -e \\"process.exit(0)\\""',
      "---",
      "",
      "# Plan",
      "",
      "- [ ] Implement OAuth callback handler",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    prdFile,
    [
      "# PRD",
      "",
      "## Goals",
      "",
      "## Functional Requirements",
      "",
      "## Acceptance Criteria",
      "",
    ].join("\n"),
    "utf8"
  );

  const result = await enforcePrdRefsCoverage({ taskFile, prdFile });
  assert.equal(result.changed, true);

  const nextText = await fs.readFile(taskFile, "utf8");
  const parsed = parseTask(nextText);
  assert.ok(Array.isArray(parsed.frontMatter.prd_refs_defaults));
  assert.ok(parsed.frontMatter.prd_refs_defaults.length > 0);
});

test("enforcePrdRefsCoverage skips docs-only plans", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-prd-refs-docs-"));
  const loopyDir = path.join(tmp, ".loopy");
  await fs.mkdir(loopyDir, { recursive: true });

  const taskFile = path.join(loopyDir, "LOOPY_PLAN.md");
  const prdFile = path.join(loopyDir, "PRD.md");

  await fs.writeFile(
    taskFile,
    [
      "---",
      'agent_command: "node -e \\"process.exit(0)\\""',
      "---",
      "",
      "# Plan",
      "",
      "- [ ] Update README examples",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(prdFile, "# PRD\n\n## Goals\n", "utf8");

  const before = await fs.readFile(taskFile, "utf8");
  const result = await enforcePrdRefsCoverage({ taskFile, prdFile });
  const after = await fs.readFile(taskFile, "utf8");

  assert.equal(result.changed, false);
  assert.equal(after, before);
});
