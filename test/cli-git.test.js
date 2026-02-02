const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli, runCmd, initGitRepo } = require("./cli-helpers");

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

test("default git commit commits changes after successful iteration", async () => {
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
      "--git-branch",
      "loopy/test-commit",
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

test("missing git branch name fails without a TTY", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-git-branch-tty-"));
  const gitEnv = await initGitRepo(tmp);

  const { code, stderr } = await runNodeCli(
    [CLI_PATH, "--dry-run", "--agent", 'node -e "process.exit(0)"', "--max-minutes", "1"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 1);
  assert.match(stderr, /git branch/i);
  assert.match(stderr, /--git-branch/i);
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
  assert.match(promptInWorktree, /Loopy Build Prompt/);

  await assert.rejects(() => fs.readFile(path.join(tmp, ".loopy", "PROMPT.md"), "utf8"));
});

test("`--resume` resumes even with staged changes", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-resume-staged-"));
  const gitEnv = await initGitRepo(tmp);

  // Create a pending state (required for --resume).
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".loopy", "state.json"),
    JSON.stringify({ iteration: 3, lastStatus: "stopped", currentPhase: "n/a" }, null, 2) + "\n",
    "utf8"
  );

  // Stage a change (should not block in --resume mode).
  await fs.writeFile(path.join(tmp, "dirty.txt"), "hi\n", "utf8");
  await runCmd("git", ["add", "-A"], { cwd: tmp, env: gitEnv });

  const agentCmd = 'node -e "process.exit(0)"';
  const { code, stdout, stderr } = await runNodeCli(
    [CLI_PATH, "--resume", "--dry-run", "--agent", agentCmd, "--max-iterations", "1", "--backoff-ms", "0", "--max-minutes", "1"],
    { cwd: tmp, env: gitEnv }
  );
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Resume iteration 3/i);
  assert.match(stdout, /Iteration 4 start/);
});

test("`--resume` rejects `--prompt`", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-resume-prompt-"));
  await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
  await fs.writeFile(path.join(tmp, ".loopy", "state.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(tmp, ".loopy", "LOOPY_PLAN.md"), ["---", "max_iterations: 1", "backoff_ms: 0", "---", "", "# Plan", "", "- [ ] x", ""].join("\n"), "utf8");

  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--resume", "--prompt", "seed", "--agent", 'node -e "process.exit(0)"'], {
    cwd: tmp,
  });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /--resume.*--prompt/i);
  assert.match(stderr, /--prd/i);
});
