const { suite } = require("./suite");
const test = suite("cli-loop");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli, initGitRepo, writeTestConfig } = require("./cli-helpers");

async function createTmp(prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await writeTestConfig(tmp);
  return tmp;
}

test("no subcommand runs the default loop", async () => {
  const tmp = await createTmp("loopy-default-loop-");
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
  assert.match(stdout, /Loop start/);
  const prompt = await fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8");
  assert.match(prompt, /Loopy Build Prompt/);
});

test("repeated failure signature triggers guardrail sign and cooldown", async () => {
  const tmp = await createTmp("loopy-test-");
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
      "--guardrail-repeat-limit",
      "3",
      "--guardrail-cooldown-ms",
      "1",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 0);

  const progress = await fs.readFile(path.join(tmp, ".loopy", "progress.md"), "utf8");
  assert.doesNotMatch(progress, /Last status:\s+guardrail-stop/);
  const guardrails = await fs.readFile(path.join(tmp, ".loopy", "guardrails.md"), "utf8");
  assert.match(guardrails, /Repeated failure signature/);
});

test("agent output streams to `.loopy/agent_stream.log`", async () => {
  const tmp = await createTmp("loopy-stream-log-");
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
  const tmp = await createTmp("loopy-step-status-");
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
    [CLI_PATH, "--agent", agentCmd, "--max-minutes", "1", "--plain"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+it Iteration 1 start/);
  assert.match(stdout, /Agent run/);
  assert.match(stdout, /State updated/);
  assert.match(stdout, /Iteration 1 complete/);
  assert.ok(!/\x1b\[[0-9;]*m/.test(stdout));
});

test("does not execute local test command for doc-only changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tests-skip-docs-"));
  const gitEnv = await initGitRepo(tmp);

  const agentCmd = 'node -e "require(\\"fs\\").writeFileSync(\\"README.md\\", \\"Updated docs\\\\n\\")"';
  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--git-branch",
      "loopy/tests-skip-docs",
      "--test-command",
      'node -e "process.exit(1)"',
      "--max-iterations",
      "1",
      "--backoff-ms",
      "0",
      "--max-minutes",
      "1",
      "--plain",
    ],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stdout, /Tests run /);
  assert.doesNotMatch(stdout, /Tests skipped:/);

  const state = JSON.parse(await fs.readFile(path.join(tmp, ".loopy", "state.json"), "utf8"));
  assert.equal(state.lastTest, "n/a");
});

test("does not execute local test command for code changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tests-run-code-"));
  const gitEnv = await initGitRepo(tmp);

  const agentCmd =
    'node -e "const fs=require(\\"fs\\");fs.mkdirSync(\\"src\\",{recursive:true});fs.writeFileSync(\\"src/app.js\\",\\"module.exports=1;\\\\n\\")"';
  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--git-branch",
      "loopy/tests-run-code",
      "--test-command",
      'node -e "process.exit(1)"',
      "--max-iterations",
      "1",
      "--backoff-ms",
      "0",
      "--max-minutes",
      "1",
      "--plain",
    ],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stdout, /Tests run /);
  assert.doesNotMatch(stdout, /Tests fail/);

  const state = JSON.parse(await fs.readFile(path.join(tmp, ".loopy", "state.json"), "utf8"));
  assert.equal(state.lastTest, "n/a");
});

test("NO_COLOR disables ANSI formatting in logs", async () => {
  const tmp = await createTmp("loopy-no-color-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join("\n"),
    "utf8"
  );

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--agent", agentCmd, "--max-minutes", "1", "--dry-run", "--no-emoji"],
    { cwd: tmp, env: { NO_COLOR: "1" } }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Loop start/);
  assert.match(stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+it Iteration 1 start/);
  assert.ok(!/\x1b\[[0-9;]*m/.test(stdout));
});

test("default `--verbose` prints full checklist details", async () => {
  const tmp = await createTmp("loopy-verbose-plan-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join("\n"),
    "utf8"
  );

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--agent", agentCmd, "--max-minutes", "1", "--dry-run", "--auto-phase=false"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Plan details/);
  assert.match(stdout, /\[ \] do something/);
});

test("`--verbose=false` hides checklist details", async () => {
  const tmp = await createTmp("loopy-verbose-off-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join("\n"),
    "utf8"
  );

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--agent", agentCmd, "--max-minutes", "1", "--dry-run", "--verbose=false", "--auto-phase=false"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.ok(!stdout.includes("Plan details"), stdout);
  assert.ok(!/\[ \] do something/.test(stdout), stdout);
  assert.match(stdout, /Plan 1 task/);
});

test("default streaming mirrors agent output to terminal", async () => {
  const tmp = await createTmp("loopy-stream-default-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"STREAM_OUT\\"); console.error(\\"STREAM_ERR\\")"';
  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--auto-phase=false",
      "--max-iterations",
      "1",
      "--backoff-ms",
      "0",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0);
  const combined = `${stdout}\n${stderr}`;
  // Check that output appears as standalone lines (streaming enabled)
  assert.match(combined, /^STREAM_OUT$/m);
  assert.match(combined, /^STREAM_ERR$/m);
});

test("default streaming mirrors agent output to terminal", async () => {
  const tmp = await createTmp("loopy-stream-terminal-");
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
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0);
  const combined = `${stdout}\n${stderr}`;
  // Check that output appears as standalone lines (streaming enabled)
  assert.match(combined, /^out$/m);
  assert.match(combined, /^err$/m);
});

test("`--no-stream` disables mirroring agent output to terminal", async () => {
  const tmp = await createTmp("loopy-no-stream-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"streamtest\\"); console.error(\\"errortest\\")"';
  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--no-stream",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0);
  const combined = `${stdout}\n${stderr}`;
  // Check that the output does NOT appear as standalone lines (streaming disabled)
  assert.doesNotMatch(combined, /^streamtest$/m);
  assert.doesNotMatch(combined, /^errortest$/m);
});

test("`--dry-run` stops after the first iteration (no backoff loop)", async () => {
  const tmp = await createTmp("loopy-dry-run-single-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] seed", ""].join("\n"),
    "utf8"
  );

  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--test-command",
      'node -e "process.exit(0)"',
      "--agent",
      'node -e "process.exit(0)"',
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 0, stderr);
  assert.match(stdout, /Iteration 1 start/);
  assert.equal(stdout.includes("Iteration 2 start"), false, stdout);
  assert.equal(stdout.includes("Sleeping"), false, stdout);
  assert.match(stdout, /Dry run complete; stopping/i);
});

test("phase progression: `--phase-only` stops after phase completion and records phase history", async () => {
  const tmp = await createTmp("loopy-phase-only-");

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
      "- [ ] document phase 1",
      "",
      "## Phase: phase2",
      "<!-- loopy:phase phase2 -->",
      "- [ ] document phase 2",
      "",
    ].join("\n"),
    "utf8"
  );

  const agentCmd =
    'node -e "const fs=require(\\\"fs\\\");let t=fs.readFileSync(\\\".loopy/LOOPY_PLAN.md\\\",\\\"utf8\\\");t=t.replace(/- \\[ \\] document phase 1/,\\\"- [x] document phase 1\\\");fs.writeFileSync(\\\".loopy/LOOPY_PLAN.md\\\",t);process.exit(0)"';

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

test("archives completed loop files to archive/<branch> on loop completion", async () => {
  const tmp = await createTmp("loopy-archive-plan-");
  const gitEnv = await initGitRepo(tmp);

  const agentCmd =
    `node -e "const fs=require('fs');let t=fs.readFileSync('.loopy/LOOPY_PLAN.md','utf8');t=t.replace(/- \\\\[ \\\\]/, '- [x]');fs.writeFileSync('.loopy/LOOPY_PLAN.md',t);"`;
  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--git-branch",
      "loopy/archive-plan",
      "--git-commit=false",
      "--max-iterations",
      "1",
      "--backoff-ms",
      "0",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  await assert.rejects(() => fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8"));
  await assert.rejects(() => fs.readFile(path.join(tmp, ".loopy", "state.json"), "utf8"));

  const archived = await fs.readFile(
    path.join(tmp, ".loopy", "archive", "archive-plan", "LOOPY_PLAN.md"),
    "utf8"
  );
  assert.match(archived, /- \[x\]/i);
});

test("creates a fresh plan on the next loop after archiving", async () => {
  const tmp = await createTmp("loopy-archive-regen-");
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] do it", ""].join("\n"),
    "utf8"
  );

  const completeCmd =
    `node -e "const fs=require('fs');let t=fs.readFileSync('.loopy/LOOPY_PLAN.md','utf8');t=t.replace(/- \\\\[ \\\\]/, '- [x]');fs.writeFileSync('.loopy/LOOPY_PLAN.md',t);"`;
  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--agent", completeCmd, "--max-iterations", "1", "--backoff-ms", "0", "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  await assert.rejects(() => fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8"));
  const archived = await fs.readFile(
    path.join(tmp, ".loopy", "archive", "completed-loop", "LOOPY_PLAN.md"),
    "utf8"
  );
  assert.match(archived, /- \[x\]/i);

  const { code: regenCode, stderr: regenErr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "new work",
      "--generate-prd=false",
      "--test-command",
      'node -e "process.exit(0)"',
      "--auto-phase=false",
      "--agent",
      'node -e "process.exit(0)"',
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(regenCode, 0, regenErr);

  const newPlan = await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  assert.match(newPlan, /- \[ \] new work/);
});
