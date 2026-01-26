const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CLI_PATH = path.resolve(__dirname, "..", "bin", "loopy.js");

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
    GIT_AUTHOR_NAME: "ralph-test",
    GIT_AUTHOR_EMAIL: "ralph-test@example.com",
    GIT_COMMITTER_NAME: "ralph-test",
    GIT_COMMITTER_EMAIL: "ralph-test@example.com",
  };
  await runCmd("git", ["init"], { cwd: tmp });
  await fs.writeFile(path.join(tmp, ".gitignore"), ["/.ralph", "/PROMPT.md"].join("\n") + "\n", "utf8");

  if (withTask) {
    await fs.writeFile(
      path.join(tmp, "RALPH_TASK.md"),
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

test("`help` command prints usage and exits 0", async () => {
  const { code, stdout } = await runNodeCli([CLI_PATH, "help"]);
  assert.equal(code, 0);
  assert.match(stdout, /Loopy/);
});

test("unknown command exits 1", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "nope"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command/);
  assert.match(stdout, /Usage:/);
});

test("loop stops on repeated failure signature guardrail", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-test-"));
  const taskPath = path.join(tmp, "RALPH_TASK.md");
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
      "RALPH_TASK.md",
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

  const progress = await fs.readFile(path.join(tmp, ".ralph", "progress.md"), "utf8");
  assert.match(progress, /Last status:\s+guardrail-stop/);
  assert.match(progress, /Repeated failure signature/);
});

test("`--git-branch` creates/switches branch before iteration", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-git-branch-"));
  const gitEnv = await initGitRepo(tmp);

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--dry-run", "--git-branch", "ralph/test-branch"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  const head = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: tmp });
  assert.equal(head.code, 0);
  assert.equal(head.stdout.trim(), "ralph/test-branch");
});

test("`--git-commit` commits changes after successful iteration", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-git-commit-"));
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
      "RALPH_TASK.md",
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-git-worktree-"));
  const gitEnv = await initGitRepo(tmp);

  const wt = path.join(tmp, "wt");
  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--dry-run", "--git-worktree", wt, "--git-worktree-branch", "ralph/wt-branch"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);

  const head = await runCmd("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(head.code, 0);
  assert.equal(head.stdout.trim(), "ralph/wt-branch");

  const promptInWorktree = await fs.readFile(path.join(wt, "PROMPT.md"), "utf8");
  assert.match(promptInWorktree, /Loopy Loop Prompt/);

  await assert.rejects(() => fs.readFile(path.join(tmp, "PROMPT.md"), "utf8"));
});

test("agent output streams to `.ralph/agent_stream.log`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-stream-log-"));
  await fs.writeFile(
    path.join(tmp, "RALPH_TASK.md"),
    ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Task", "", "- [ ] do something", ""].join(
      "\n"
    ),
    "utf8"
  );

  const agentCmd = 'node -e "console.log(\\"out\\"); console.error(\\"err\\")"';
  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "run", "--task", "RALPH_TASK.md", "--agent-cmd", agentCmd, "--max-minutes", "1"],
    { cwd: tmp }
  );
  assert.equal(code, 0, stderr);

  const streamLog = await fs.readFile(path.join(tmp, ".ralph", "agent_stream.log"), "utf8");
  assert.match(streamLog, /Iteration 1/);
  assert.match(streamLog, /\bout\b/);
  assert.match(streamLog, /\berr\b/);
});

test("`--stream` mirrors agent output to terminal", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-stream-terminal-"));
  await fs.writeFile(
    path.join(tmp, "RALPH_TASK.md"),
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
      "RALPH_TASK.md",
      "--agent-cmd",
      agentCmd,
      "--stream",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp }
  );
  assert.equal(code, 0);
  assert.match(stdout, /\bout\b/);
  assert.match(stderr, /\berr\b/);
});
