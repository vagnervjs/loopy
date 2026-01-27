const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli } = require("./cli-helpers");

test("no subcommand runs the default loop", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-default-loop-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", 'agent_command: "ignored"', "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do it", ""].join(
      "\n"
    ),
    "utf8"
  );
  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--agent", agentCmd, "--max-iterations", "1", "--backoff-ms", "0", "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Starting loop/);
  const prompt = await fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8");
  assert.match(prompt, /Loopy Loop Prompt/);
});

test("loop stops on repeated failure signature guardrail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-test-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  const taskPath = path.join(tmp, ".loopy", "LOOPY_PLAN.md");
  await fs.writeFile(
    taskPath,
    [
      "---",
      'agent_command: "ignored"',
      "max_iterations: 10",
      "backoff_ms: 0",
      "---",
      "",
      "# Plan",
      "",
      "- [ ] do something",
      "",
    ].join("\n"),
    "utf8"
  );

  const agentCmd = 'node -e "console.error(\\"boom\\"); process.exit(1)"';

  const { code } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--max-iterations",
      "10",
      "--backoff-ms",
      "0",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 0);

  const progress = await fs.readFile(path.join(tmp, ".loopy", "progress.md"), "utf8");
  assert.match(progress, /Last status:\s+guardrail-stop/);
  assert.match(progress, /Repeated failure signature/);
});

test("agent output streams to `.loopy/agent_stream.log`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-stream-log-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"out\\"); console.error(\\"err\\")"';
  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--agent", agentCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const streamLog = await fs.readFile(path.join(tmp, ".loopy", "agent_stream.log"), "utf8");
  assert.match(streamLog, /Iteration 1/);
  assert.match(streamLog, /\bout\b/);
  assert.match(streamLog, /\berr\b/);
});

test("prints step status lines to terminal during loop", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-step-status-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--agent", agentCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\[loopy\] iter 1: Iteration start/);
  assert.match(stdout, /\[loopy\] iter 1: Running agent:/);
  assert.match(stdout, /\[loopy\] iter 1: State updated:/);
});

test("`--stream` mirrors agent output to terminal", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-stream-terminal-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"out\\"); console.error(\\"err\\")"';
  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--stream",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0);
  const combined = `${stdout}\n${stderr}`;
  assert.match(combined, /\bout\b/);
  assert.match(combined, /\berr\b/);
});

test("`--dry-run` stops after the first iteration (no backoff loop)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-dry-run-single-"));

  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "seed",
      "--auto-phase=false",
      "--agent",
      'node -e "process.exit(0)"',
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 0, stderr);
  assert.match(stdout, /\[loopy\] iter 1: Iteration start/);
  assert.equal(stdout.includes("[loopy] iter 2: Iteration start"), false, stdout);
  assert.equal(stdout.includes("Sleeping "), false, stdout);
  assert.match(stdout, /Dry run complete\. Stopping\./);
});

test("phase progression: `--phase-only` stops after phase completion and records phase history", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-phase-only-"));

  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    [
      "---",
      "max_iterations: 5",
      "backoff_ms: 0",
      "phases:",
      "  - id: phase1",
      "    title: Phase 1",
      "  - id: phase2",
      "    title: Phase 2",
      "---",
      "",
      "# Plan",
      "",
      "## Phase: phase1",
      "<!-- loopy:phase phase1 -->",
      "- [ ] do phase 1",
      "",
      "## Phase: phase2",
      "<!-- loopy:phase phase2 -->",
      "- [ ] do phase 2",
      "",
    ].join("\n"),
    "utf8"
  );

  const agentCmd =
    'node -e "const fs=require(\\\"fs\\\");let t=fs.readFileSync(\\\".loopy/LOOPY_PLAN.md\\\",\\\"utf8\\\");t=t.replace(/(## Phase: phase1[\\\\s\\\\S]*?- \\\\[) \\\\]/,(m,g1)=>g1+\\\"x]\\\");fs.writeFileSync(\\\".loopy/LOOPY_PLAN.md\\\",t);process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--phase-only",
      "--max-iterations",
      "5",
      "--backoff-ms",
      "0",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const state = JSON.parse(await fs.readFile(path.join(tmp, ".loopy", "state.json"), "utf8"));
  assert.equal(state.lastStatus, "phase-complete");
  assert.equal(state.currentPhase, "phase1");
  assert.ok(Array.isArray(state.phaseHistory));
  assert.match(state.phaseHistory.join("\n"), /phase phase1 complete/);

  const progress = await fs.readFile(path.join(tmp, ".loopy", "progress.md"), "utf8");
  assert.match(progress, /Current phase:\s+phase1/);
});
