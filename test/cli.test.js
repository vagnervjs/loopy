// Deprecated: tests split into module-specific files.
if (false) {
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CLI_PATH = path.resolve(__dirname, "..", "bin", "loopy.js");
const { version: LOOPY_VERSION } = require("../package.json");

function runNodeCli(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runNodeCliWithStdin(args, { cwd, env, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    try {
      child.stdin.write(String(stdin || ""));
    } catch (_) {
      // ignore
    }
    try {
      child.stdin.end();
    } catch (_) {
      // ignore
    }

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runCmd(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args || [], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function extractHelpDescriptionColumns(helpText, indent) {
  const lines = String(helpText || "").split(/\r?\n/);
  const cols = [];
  for (const line of lines) {
    if (!line.startsWith(`${indent}--`)) continue;
    const m = line.match(/^(\s*)(--.+?)(\s{2,})(\S)/);
    if (!m) continue;
    cols.push(m[1].length + m[2].length + m[3].length);
  }
  return cols;
}

function assertHelpAligned(helpText) {
  const commonCols = extractHelpDescriptionColumns(helpText, "  ");
  assert.ok(commonCols.length >= 2, "expected at least two common option rows");
  assert.equal(new Set(commonCols).size, 1, `common option descriptions misaligned: ${commonCols.join(", ")}`);

  const advancedCols = extractHelpDescriptionColumns(helpText, "    ");
  assert.ok(advancedCols.length >= 2, "expected at least two advanced option rows");
  assert.equal(new Set(advancedCols).size, 1, `advanced option descriptions misaligned: ${advancedCols.join(", ")}`);
}

async function initGitRepo(tmp, { withTask = true } = {}) {
  const gitEnv = {
    GIT_AUTHOR_NAME: "loopy-test",
    GIT_AUTHOR_EMAIL: "loopy-test@example.com",
    GIT_COMMITTER_NAME: "loopy-test",
    GIT_COMMITTER_EMAIL: "loopy-test@example.com",
  };
  await runCmd("git", ["init"], { cwd: tmp });
  await fs.writeFile(
    path.join(tmp, ".gitignore"),
    ["/node_modules", "/.loopy/*", "!/.loopy/LOOPY_PLAN.md"].join("\n") + "\n",
    "utf8"
  );

  if (withTask) {
    await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
      [
        "---",
        "max_iterations: 1",
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
  }

  await runCmd("git", ["add", "-A"], { cwd: tmp });
  const commit = await runCmd("git", ["commit", "-m", "init"], { cwd: tmp, env: gitEnv });
  if (commit.code !== 0) throw new Error(`Failed to init git repo: ${commit.stderr || commit.stdout}`);
  return gitEnv;
}

test("`--help` prints usage and exits 0", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--help"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /\bloopy help\b/);
  assert.match(stdout, /--continue\b/);
  assertHelpAligned(stdout);
  assert.match(
    stdout,
    /--git-commit-message <template>\s+Commit message template \(default: loopy: \{change_type\} \{task_summary\}\)/
  );
  assert.ok(!/Default commit template:/i.test(stdout));
  assert.ok(!/default shown below/i.test(stdout));
});

test("`--version` prints version and exits 0", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--version"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(stdout.trim(), LOOPY_VERSION);
});

test("`help` command prints usage and exits 0", async () => {
  const { code, stdout } = await runNodeCli([CLI_PATH, "help"]);
  assert.equal(code, 0);
  assert.match(stdout, /Loopy/);
  assertHelpAligned(stdout);
  assert.match(
    stdout,
    /--git-commit-message <template>\s+Commit message template \(default: loopy: \{change_type\} \{task_summary\}\)/
  );
  assert.ok(!/Default commit template:/i.test(stdout));
  assert.ok(!/default shown below/i.test(stdout));
});

test("`status` prints summary from `.loopy/state.json`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-status-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "state.json"),
    JSON.stringify(
      {
        iteration: 12,
        lastStatus: "guardrail-stop",
        lastTest: "n/a",
        lastError: "Repeated failure signature (>= 3).",
        lastHint: "Try a different approach.",
        lastHintAt: "2026-01-26T01:16:00.000Z",
        hintCount: 3,
        lastBytes: 8856,
        updatedAt: "2026-01-26T01:16:24.741Z",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "status"], { cwd: tmp });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /Loopy status/);
  assert.match(stdout, /Iteration:\s+12/);
  assert.match(stdout, /Last status:\s+guardrail-stop/);
  assert.match(stdout, /Last test:\s+n\/a/);
  assert.match(stdout, /Last error:\s+Repeated failure signature/);
  assert.match(stdout, /Last hint:\s+Try a different approach\./);
  assert.match(stdout, /Last hint at:\s+2026-01-26T01:16:00.000Z/);
  assert.match(stdout, /Hint count:\s+3/);
  assert.match(stdout, /Last bytes:\s+8856/);
  assert.match(stdout, /Updated at:\s+2026-01-26T01:16:24.741Z/);
});

test("`status` exits 1 with friendly message when state file is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-status-missing-"));
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "status"], { cwd: tmp });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /No Loopy state found/);
  assert.match(stderr, /Run `loopy`/);
});

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

test("unsupported legacy seed flag exits 1", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-legacy-seed-"));
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--dry-run", "--task-prompt", "build a thing"], {
    cwd: tmp,
  });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /Unsupported legacy seed flag/i);
});

test("unknown command exits 1", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "nope"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command/);
  assert.match(stdout, /Usage:/);
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

test("`--git-branch` creates/switches branch before iteration", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-git-branch-"));
  const gitEnv = await initGitRepo(tmp);

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--agent", 'node -e "process.exit(0)"', "--git-branch", "loopy/test-branch"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  const head = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmp });
  assert.equal(head.code, 0);
  assert.equal(head.stdout.trim(), "loopy/test-branch");
});

test("`--git-commit` commits changes after successful iteration", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-git-commit-"));
  const gitEnv = await initGitRepo(tmp);

  await fs.writeFile(path.join(tmp, "tracked.txt"), "one\n", "utf8");
  await runCmd("git", ["add", "-A"], { cwd: tmp });
  await runCmd("git", ["commit", "-m", "add tracked"], { cwd: tmp, env: gitEnv });

  const agentCmd = 'node -e "require(\\"fs\\").writeFileSync(\\"tracked.txt\\", \\"two\\\\n\\")"';
  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--agent",
      agentCmd,
      "--git-commit",
      "--git-commit-message",
      "it {iteration} {status}",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  const count = await runCmd("git", ["rev-list", "--count", "HEAD"], { cwd: tmp });
  assert.equal(count.code, 0);
  assert.equal(Number(count.stdout.trim()), 3);

  const subject = await runCmd("git", ["log", "-1", "--pretty=%s"], { cwd: tmp });
  assert.equal(subject.code, 0);
  assert.match(subject.stdout.trim(), /^it 1 success$/);
});

test("`--git-worktree` runs loop inside worktree path", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-git-worktree-"));
  const gitEnv = await initGitRepo(tmp);

  const wt = path.join(tmp, "wt");
  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--agent",
      'node -e "process.exit(0)"',
      "--git-worktree",
      wt,
      "--git-worktree-branch",
      "loopy/wt-branch",
    ],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  const head = await runCmd("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.code, 0);
  assert.equal(head.stdout.trim(), "loopy/wt-branch");

  const promptInWorktree = await fs.readFile(path.join(wt, ".loopy", "PROMPT.md"), "utf8");
  assert.match(promptInWorktree, /Loopy Loop Prompt/);

  await assert.rejects(() => fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8"));
});

test("`--continue` resumes even with staged changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-continue-staged-"));
  const gitEnv = await initGitRepo(tmp);

  // Create a pending state (required for --continue).
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "state.json"),
    JSON.stringify({ iteration: 3, lastStatus: "stopped", currentPhase: "n/a" }, null, 2) + "\n",
    "utf8"
  );

  // Stage a change (should not block in --continue mode).
  await fs.writeFile(path.join(tmp, "dirty.txt"), "hi\n", "utf8");
  await runCmd("git", ["add", "-A"], { cwd: tmp, env: gitEnv });

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--continue", "--dry-run", "--agent", agentCmd, "--max-iterations", "1", "--backoff-ms", "0", "--max-minutes", "1"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Continuing from saved state/);
  assert.match(stdout, /\[loopy\] iter \d+: Iteration start/);
});

test("`--continue` rejects `--prompt`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-continue-prompt-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".loopy", "state.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] x", ""].join("\n"), "utf8");

  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--continue", "--prompt", "seed", "--agent", 'node -e "process.exit(0)"'], {
    cwd: tmp,
  });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /--continue.*--prompt/i);
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

test("auto-phase task creation requires confirmation with `--confirm`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-confirm-"));

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "build a thing",
      "--confirm",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 1);
  assert.match(stderr, /Aborted|not created|confirmation/i);
  await assert.rejects(() => fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8"));
});

test("`--prompt` updates an existing plan without confirmation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-prompt-update-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] old plan", ""].join("\n"),
    "utf8"
  );

  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "new plan",
      "--agent",
      'node -e "process.exit(0)"',
      "--auto-phase=false",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("[loopy] Plan updated before loop:"), stdout);

  const task = await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  assert.match(task, /- \[ \]\s+new plan/);
  assert.ok(!task.includes("old plan"), task);
});

test("`--prompt` update requires confirmation with `--confirm`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-prompt-confirm-update-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] old plan", ""].join("\n"),
    "utf8"
  );

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "new plan",
      "--confirm",
      "--agent",
      'node -e "process.exit(0)"',
      "--auto-phase=false",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 1);
  assert.match(stderr, /Aborted|not updated|confirmation/i);

  const task = await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  assert.match(task, /- \[ \]\s+old plan/);
  assert.ok(!task.includes("new plan"), task);
});

test("`--prompt` generates phased `LOOPY_PLAN.md` before looping", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-generate-"));

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "build a thing",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("[loopy] Plan updated before loop:"), stdout);
  assert.ok(stdout.includes("[loopy] iter 1: Iteration start"), stdout);
  assert.ok(
    stdout.indexOf("[loopy] Plan updated before loop:") < stdout.indexOf("[loopy] iter 1: Iteration start"),
    stdout
  );

  const task = await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  assert.match(task, /phases:/);
  assert.match(task, /## Phase:\s+build/);
  assert.match(task, /- \[ \]\s+do build/);
});

test("`--prompt @file` generates phased `LOOPY_PLAN.md` before looping", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-generate-file-"));
  await fs.writeFile(path.join(tmp, "task.txt"), "build a thing\n", "utf8");

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "@task.txt",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("[loopy] Plan updated before loop:"), stdout);
  assert.ok(stdout.includes("[loopy] iter 1: Iteration start"), stdout);
  assert.ok(
    stdout.indexOf("[loopy] Plan updated before loop:") < stdout.indexOf("[loopy] iter 1: Iteration start"),
    stdout
  );

  const task = await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  assert.match(task, /phases:/);
  assert.match(task, /## Phase:\s+build/);
  assert.match(task, /- \[ \]\s+do build/);
});

test("`--prompt @file` accepts markdown and includes it in `.loopy/PROMPT.md`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-md-"));
  await fs.writeFile(
    path.join(tmp, "PRD.md"),
    ["# PRD: Build a thing", "", "## Requirements", "- Must support X", "- Must support Y", "", "## Notes", "Use Z."].join(
      "\n"
    ) + "\n",
    "utf8"
  );

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "@PRD.md",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const prompt = await fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8");
  assert.match(prompt, /## Plan seed \(PRD\)/);
  assert.match(prompt, /# PRD: Build a thing/);
  assert.match(prompt, /## Requirements/);
  assert.match(prompt, /- Must support X/);
  assert.match(prompt, /## Plan \(LOOPY_PLAN\.md\)/);
});

test("`--prompt @file` accepts arbitrary extensions (.rst) and includes it in `.loopy/PROMPT.md`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-rst-"));
  await fs.writeFile(
    path.join(tmp, "spec.rst"),
    ["Loopy PRD", "========", "", "* requirement A", "* requirement B", ""].join("\n"),
    "utf8"
  );

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "@spec.rst",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const prompt = await fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8");
  assert.match(prompt, /## Plan seed \(PRD\)/);
  assert.match(prompt, /Loopy PRD/);
  assert.match(prompt, /\* requirement A/);
});

test("`--prompt -` reads prompt from stdin", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-generate-stdin-"));

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stdout, stderr } = await runNodeCliWithStdin(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "-",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp, stdin: "build a thing\n" }
  );
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("[loopy] Plan updated before loop:"), stdout);
  assert.ok(stdout.includes("[loopy] iter 1: Iteration start"), stdout);
  assert.ok(
    stdout.indexOf("[loopy] Plan updated before loop:") < stdout.indexOf("[loopy] iter 1: Iteration start"),
    stdout
  );

  const task = await fs.readFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), "utf8");
  assert.match(task, /## Phase:\s+build/);
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

test("`--prompt @file` errors on missing file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-missing-"));
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--prompt", "@nope.txt", "--agent", plannerCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Seed prompt file not found/i);
});

test("`--prompt @file` errors on empty file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-empty-"));
  await fs.writeFile(path.join(tmp, "empty.txt"), "   \n\n", "utf8");
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--prompt", "@empty.txt", "--agent", plannerCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Seed prompt file is empty/i);
});

test("`--prompt @file` errors on unreadable file", async () => {
  if (process.platform === "win32") return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-unreadable-"));
  const filePath = path.join(tmp, "secret.md");
  await fs.writeFile(filePath, "# secret\n", "utf8");
  await fs.chmod(filePath, 0o000);

  const plannerCmd = 'node -e "process.exit(0)"';
  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "@secret.md",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Permission denied reading seed prompt file/i);

  // Restore permissions so temp cleanup can proceed.
  await fs.chmod(filePath, 0o644);
});

test("`--prompt @file` errors when path is a directory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-dir-"));
  await fs.mkdir(path.join(tmp, "seedDir"), { recursive: true });
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "--dry-run",
      "--prompt",
      "@seedDir",
      "--agent",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Seed prompt path is a directory/i);
});

test("unsupported legacy seed flag errors even when `--prompt` is provided", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-both-"));
  await fs.writeFile(path.join(tmp, "task.txt"), "build a thing\n", "utf8");
  const agentCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--prompt", "inline", "--task-file", "task.txt", "--agent", agentCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Unsupported legacy seed flag/i);
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
    JSON.stringify({
      iteration: 5,
      lastHint: "Second hint",
      lastHintAt: "2026-01-27T02:00:00.000Z",
      hintCount: 2,
    }, null, 2) + "\n",
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
    JSON.stringify({
      iteration: 5,
      lastHint: "Second hint",
      lastHintAt: "2026-01-27T02:00:00.000Z",
      hintCount: 2,
    }, null, 2) + "\n",
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
}
