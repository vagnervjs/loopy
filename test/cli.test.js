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

async function initGitRepo(tmp, { withTask = true } = {}) {
  const gitEnv = {
    GIT_AUTHOR_NAME: "loopy-test",
    GIT_AUTHOR_EMAIL: "loopy-test@example.com",
    GIT_COMMITTER_NAME: "loopy-test",
    GIT_COMMITTER_EMAIL: "loopy-test@example.com",
  };
  await runCmd("git", ["init"], { cwd: tmp });
  await fs.writeFile(path.join(tmp, ".gitignore"), ["/.loopy", "/PROMPT.md"].join("\n") + "\n", "utf8");

  if (withTask) {
    await fs.writeFile(
      path.join(tmp, "LOOPY_TASK.md"),
      [
        "---",
        "max_iterations: 1",
        "backoff_ms: 0",
        "---",
        "",
        "# Task",
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
  assert.match(stdout, /Last bytes:\s+8856/);
  assert.match(stdout, /Updated at:\s+2026-01-26T01:16:24.741Z/);
});

test("`status` exits 1 with friendly message when state file is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-status-missing-"));
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "status"], { cwd: tmp });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /No Loopy state found/);
  assert.match(stderr, /loopy run|loopy loop/);
});

test("unknown command exits 1", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "nope"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command/);
  assert.match(stdout, /Usage:/);
});

test("loop stops on repeated failure signature guardrail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-test-"));
  const taskPath = path.join(tmp, "LOOPY_TASK.md");
  await fs.writeFile(
    taskPath,
    [
      "---",
      'agent_command: "ignored"',
      "max_iterations: 10",
      "backoff_ms: 0",
      "---",
      "",
      "# Task",
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
      "loop",
      "--task",
      "LOOPY_TASK.md",
      "--agent-cmd",
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
    [CLI_PATH, "run", "--dry-run", "--git-branch", "loopy/test-branch"],
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
      "run",
      "--task",
      "LOOPY_TASK.md",
      "--agent-cmd",
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
    [CLI_PATH, "run", "--dry-run", "--git-worktree", wt, "--git-worktree-branch", "loopy/wt-branch"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  const head = await runCmd("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.code, 0);
  assert.equal(head.stdout.trim(), "loopy/wt-branch");

  const promptInWorktree = await fs.readFile(path.join(wt, "PROMPT.md"), "utf8");
  assert.match(promptInWorktree, /Loopy Loop Prompt/);

  await assert.rejects(() => fs.readFile(path.join(tmp, "PROMPT.md"), "utf8"));
});

test("agent output streams to `.loopy/agent_stream.log`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-stream-log-"));
  await fs.writeFile(
    path.join(tmp, "LOOPY_TASK.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Task", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"out\\"); console.error(\\"err\\")"';
  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--task", "LOOPY_TASK.md", "--agent-cmd", agentCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const streamLog = await fs.readFile(path.join(tmp, ".loopy", "agent_stream.log"), "utf8");
  assert.match(streamLog, /Iteration 1/);
  assert.match(streamLog, /\bout\b/);
  assert.match(streamLog, /\berr\b/);
});

test("prints step status lines to terminal during run", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-step-status-"));
  await fs.writeFile(
    path.join(tmp, "LOOPY_TASK.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Task", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--task", "LOOPY_TASK.md", "--agent-cmd", agentCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\[loopy\] iter 1: Iteration start/);
  assert.match(stdout, /\[loopy\] iter 1: Running agent:/);
  assert.match(stdout, /\[loopy\] iter 1: State updated:/);
});

test("`--stream` mirrors agent output to terminal", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-stream-terminal-"));
  await fs.writeFile(
    path.join(tmp, "LOOPY_TASK.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Task", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"out\\"); console.error(\\"err\\")"';
  const { code, stdout, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--task",
      "LOOPY_TASK.md",
      "--agent-cmd",
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

test("auto-phase task creation requires confirmation without `--auto-apply`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-confirm-"));

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-prompt",
      "build a thing",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );

  assert.equal(code, 1);
  assert.match(stderr, /Aborted|not created|confirmation/i);
  await assert.rejects(() => fs.readFile(path.join(tmp, "LOOPY_TASK.md"), "utf8"));
});

test("`--task-prompt` + `--auto-apply` generates phased `LOOPY_TASK.md` before looping", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-generate-"));

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-prompt",
      "build a thing",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const task = await fs.readFile(path.join(tmp, "LOOPY_TASK.md"), "utf8");
  assert.match(task, /phases:/);
  assert.match(task, /## Phase:\s+build/);
  assert.match(task, /- \[ \]\s+do build/);
});

test("`--task-file` + `--auto-apply` generates phased `LOOPY_TASK.md` before looping", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-generate-file-"));
  await fs.writeFile(path.join(tmp, "task.txt"), "build a thing\n", "utf8");

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-file",
      "task.txt",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const task = await fs.readFile(path.join(tmp, "LOOPY_TASK.md"), "utf8");
  assert.match(task, /phases:/);
  assert.match(task, /## Phase:\s+build/);
  assert.match(task, /- \[ \]\s+do build/);
});

test("`--task-file` accepts markdown and includes it in `PROMPT.md`", async () => {
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
      "run",
      "--dry-run",
      "--task-file",
      "PRD.md",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const prompt = await fs.readFile(path.join(tmp, "PROMPT.md"), "utf8");
  assert.match(prompt, /## Task file \(PRD\)/);
  assert.match(prompt, /# PRD: Build a thing/);
  assert.match(prompt, /## Requirements/);
  assert.match(prompt, /- Must support X/);
  assert.match(prompt, /## Task \(LOOPY_TASK\.md\)/);
});

test("`--task-file` accepts arbitrary extensions (.rst) and includes it in `PROMPT.md`", async () => {
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
      "run",
      "--dry-run",
      "--task-file",
      "spec.rst",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const prompt = await fs.readFile(path.join(tmp, "PROMPT.md"), "utf8");
  assert.match(prompt, /## Task file \(PRD\)/);
  assert.match(prompt, /Loopy PRD/);
  assert.match(prompt, /\* requirement A/);
});

test("`--task-file -` reads prompt from stdin", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-auto-phase-generate-stdin-"));

  const plannerCmd =
    'node -e "process.stdout.write(\\\"phase_defaults:\\\\n  stop_on: all_checked\\\\nphases:\\\\n  - id: build\\\\n    title: Build\\\\nphase_tasks:\\\\n  build:\\\\n    - do build\\\\n\\\")"';

  const { code, stderr } = await runNodeCliWithStdin(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-file",
      "-",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp, stdin: "build a thing\n" }
  );
  assert.equal(code, 0, stderr);

  const task = await fs.readFile(path.join(tmp, "LOOPY_TASK.md"), "utf8");
  assert.match(task, /## Phase:\s+build/);
});

test("`--task-file` errors on missing file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-missing-"));
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--dry-run", "--task-file", "nope.txt", "--auto-apply", "--agent-cmd", plannerCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Task prompt file not found/i);
});

test("`--task-file` errors on empty file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-empty-"));
  await fs.writeFile(path.join(tmp, "empty.txt"), "   \n\n", "utf8");
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--dry-run", "--task-file", "empty.txt", "--auto-apply", "--agent-cmd", plannerCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Task prompt file is empty/i);
});

test("`--task-file` errors on unreadable file", async () => {
  if (process.platform === "win32") return;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-unreadable-"));
  const filePath = path.join(tmp, "secret.md");
  await fs.writeFile(filePath, "# secret\n", "utf8");
  await fs.chmod(filePath, 0o000);

  const plannerCmd = 'node -e "process.exit(0)"';
  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-file",
      "secret.md",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Permission denied reading task prompt file/i);

  // Restore permissions so temp cleanup can proceed.
  await fs.chmod(filePath, 0o644);
});

test("`--task-file` errors when path is a directory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-dir-"));
  await fs.mkdir(path.join(tmp, "seedDir"), { recursive: true });
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-file",
      "seedDir",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Task prompt path is a directory/i);
});

test("`--task-prompt` + `--task-file` errors (no precedence)", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-task-file-both-"));
  await fs.writeFile(path.join(tmp, "task.txt"), "build a thing\n", "utf8");
  const plannerCmd = 'node -e "process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "run",
      "--dry-run",
      "--task-prompt",
      "inline",
      "--task-file",
      "task.txt",
      "--auto-apply",
      "--agent-cmd",
      plannerCmd,
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 1);
  assert.match(stderr, /Provide only one of --task-prompt or --task-file/i);
});

test("phase progression: `--phase-only` stops after phase completion and records phase history", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-phase-only-"));

  await fs.writeFile(
    path.join(tmp, "LOOPY_TASK.md"),
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
      "# Task",
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
    'node -e "const fs=require(\\\"fs\\\");let t=fs.readFileSync(\\\"LOOPY_TASK.md\\\",\\\"utf8\\\");t=t.replace(/(## Phase: phase1[\\\\s\\\\S]*?- \\\\[) \\\\]/,(m,g1)=>g1+\\\"x]\\\");fs.writeFileSync(\\\"LOOPY_TASK.md\\\",t);process.exit(0)"';

  const { code, stderr } = await runNodeCli(
    [
      CLI_PATH,
      "loop",
      "--agent-cmd",
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
