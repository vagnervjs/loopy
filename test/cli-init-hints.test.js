const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli } = require("./cli-helpers");

test("`init` scaffolds `.loopy/LOOPY_PLAN.md` and `.loopy/hints.md`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-init-"));
  const { code, stderr } = await runNodeCli([CLI_PATH, "init"], { cwd: tmp });
  assert.equal(code, 0, stderr);
  await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  const hints = await fs.readFile(path.join(tmp, ".loopy", "hints.md"), "utf8");
  assert.match(hints, /Loopy Hints/);
});

test("`hint` appends and appears in next `.loopy/PROMPT.md`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-hint-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", 'agent_command: "ignored"', "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do it", ""].join(
      "\n"
    ),
    "utf8"
  );

  const { code: hintCode, stderr: hintErr } = await runNodeCli([CLI_PATH, "hint", "Remember to handle edge cases."], {
    cwd: tmp,
  });
  assert.equal(hintCode, 0, hintErr);

  const hints = await fs.readFile(path.join(tmp, ".loopy", "hints.md"), "utf8");
  assert.match(hints, /Remember to handle edge cases\./);

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--agent", agentCmd, "--max-iterations", "1", "--backoff-ms", "0", "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const prompt = await fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8");
  assert.match(prompt, /## Hints/);
  assert.match(prompt, /Remember to handle edge cases\./);
});

test("`hint --reset` clears hints and state", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-hint-reset-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });

  // Create initial hints
  await fs.writeFile(
    path.join(tmp, ".loopy", "hints.md"),
    "# Loopy Hints\n\n- 2026-01-27T01:00:00.000Z First hint\n- 2026-01-27T02:00:00.000Z Second hint\n",
    "utf8"
  );

  // Create initial state with hint info
  await fs.writeFile(
    path.join(tmp, ".loopy", "state.json"),
    JSON.stringify(
      {
        iteration: 5,
        lastHint: "Second hint",
        lastHintAt: "2026-01-27T02:00:00.000Z",
        hintCount: 2,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "hint", "--reset"], { cwd: tmp });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Hints reset/);

  // Verify hints file is reset to header only
  const hints = await fs.readFile(path.join(tmp, ".loopy", "hints.md"), "utf8");
  assert.equal(hints, "# Loopy Hints\n\n");

  // Verify state is updated
  const state = JSON.parse(await fs.readFile(path.join(tmp, ".loopy", "state.json"), "utf8"));
  assert.equal(state.hintCount, 0);
  assert.equal(state.lastHint, null);
  assert.equal(state.lastHintAt, null);
  assert.equal(state.iteration, 5); // preserved
});

test("`hint --pop` removes last hint", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-hint-pop-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });

  // Create initial hints
  await fs.writeFile(
    path.join(tmp, ".loopy", "hints.md"),
    "# Loopy Hints\n\n- 2026-01-27T01:00:00.000Z First hint\n- 2026-01-27T02:00:00.000Z Second hint\n",
    "utf8"
  );

  // Create initial state with hint info
  await fs.writeFile(
    path.join(tmp, ".loopy", "state.json"),
    JSON.stringify(
      {
        iteration: 5,
        lastHint: "Second hint",
        lastHintAt: "2026-01-27T02:00:00.000Z",
        hintCount: 2,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "hint", "--pop"], { cwd: tmp });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Last hint removed/);

  // Verify the last hint was removed
  const hints = await fs.readFile(path.join(tmp, ".loopy", "hints.md"), "utf8");
  assert.match(hints, /First hint/);
  assert.equal(hints.includes("Second hint"), false);

  // Verify state is updated
  const state = JSON.parse(await fs.readFile(path.join(tmp, ".loopy", "state.json"), "utf8"));
  assert.equal(state.hintCount, 1);
  assert.equal(state.lastHint, "First hint");
  assert.equal(state.lastHintAt, "2026-01-27T01:00:00.000Z");
});

test("`hint --pop` when no hints exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-hint-pop-empty-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });

  // Create empty hints file (header only)
  await fs.writeFile(path.join(tmp, ".loopy", "hints.md"), "# Loopy Hints\n\n", "utf8");

  // Create initial state with no hints
  await fs.writeFile(
    path.join(tmp, ".loopy", "state.json"),
    JSON.stringify({ iteration: 1, hintCount: 0 }, null, 2) + "\n",
    "utf8"
  );

  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "hint", "--pop"], { cwd: tmp });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /No hints to pop/);

  // Verify hints file is unchanged
  const hints = await fs.readFile(path.join(tmp, ".loopy", "hints.md"), "utf8");
  assert.equal(hints, "# Loopy Hints\n\n");
});
