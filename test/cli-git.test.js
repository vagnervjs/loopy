const { suite } = require("./suite");
const test = suite("cli-git");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli, runCmd, initGitRepo } = require("./cli-helpers");
const { isFileRelatedToTask, diffGitWorktreeSnapshots } = require("../src/git");

// ── isFileRelatedToTask unit tests ──────────────────────────────────────

test("isFileRelatedToTask: returns true when task keywords appear in file path", () => {
  assert.equal(isFileRelatedToTask("jest.config.js", "update Jest config to disable coverage"), true);
});

test("isFileRelatedToTask: returns false when task keywords (2+) do not match file path", () => {
  assert.equal(isFileRelatedToTask("README.md", "update Jest config to disable coverage"), false);
});

test("isFileRelatedToTask: returns true when file basename matches task keyword", () => {
  assert.equal(isFileRelatedToTask("src/config/jest.config.ts", "configure jest"), true);
});

test("isFileRelatedToTask: returns true with no task summary (assumes related)", () => {
  assert.equal(isFileRelatedToTask("anything.js", ""), true);
});

test("isFileRelatedToTask: returns true with no file path (assumes related)", () => {
  assert.equal(isFileRelatedToTask("", "update something"), true);
});

test("isFileRelatedToTask: returns true when only stop words in task (no meaningful keywords)", () => {
  assert.equal(isFileRelatedToTask("random.js", "add the new file"), true);
});

test("isFileRelatedToTask: returns true when only 1 meaningful keyword (too vague to filter)", () => {
  assert.equal(isFileRelatedToTask("random.js", "do something"), true);
});

test("isFileRelatedToTask: handles directory path matching", () => {
  assert.equal(isFileRelatedToTask("src/authentication/login.js", "implement authentication"), true);
});

test("isFileRelatedToTask: case insensitive matching", () => {
  assert.equal(isFileRelatedToTask("src/Router.jsx", "implement router navigation"), true);
});

test("isFileRelatedToTask: package.json not related to Jest config task", () => {
  assert.equal(isFileRelatedToTask("package.json", "update Jest config to disable coverage"), false);
});

test("diffGitWorktreeSnapshots: returns empty when snapshots are identical", () => {
  const before = {
    "a.js": { status: " M", exists: true, size: 10, mtimeMs: 1000 },
  };
  const after = {
    "a.js": { status: " M", exists: true, size: 10, mtimeMs: 1000 },
  };
  assert.deepStrictEqual(diffGitWorktreeSnapshots(before, after), []);
});

test("diffGitWorktreeSnapshots: detects changed, added, and removed files", () => {
  const before = {
    "a.js": { status: " M", exists: true, size: 10, mtimeMs: 1000 },
    "b.js": { status: " M", exists: true, size: 5, mtimeMs: 1000 },
  };
  const after = {
    "a.js": { status: " M", exists: true, size: 11, mtimeMs: 1001 }, // changed
    "c.js": { status: "??", exists: true, size: 1, mtimeMs: 1002 }, // added
  };
  assert.deepStrictEqual(diffGitWorktreeSnapshots(before, after), ["a.js", "b.js", "c.js"]);
});

test("diffGitWorktreeSnapshots: returns empty when either snapshot is missing", () => {
  const snapshot = {
    "a.js": { status: " M", exists: true, size: 10, mtimeMs: 1000 },
  };
  assert.deepStrictEqual(diffGitWorktreeSnapshots(null, snapshot), []);
  assert.deepStrictEqual(diffGitWorktreeSnapshots(snapshot, null), []);
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

test("default git commit excludes configured `loopy_dir` artifacts", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-git-commit-custom-dir-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-home-"));
  const gitEnv = await initGitRepo(tmp);

  await fs.mkdir(path.join(home, ".loopy"), { recursive: true });
  await fs.writeFile(path.join(home, ".loopy", "config.yml"), ["defaults:", "  loopy_dir: ./loopy", ""].join("\n"), "utf8");

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
      "loopy/test-custom-dir-commit",
      "--git-commit-message",
      "it {iteration} {status}",
      "--max-minutes",
      "1",
    ],
    { cwd: tmp, env: { ...gitEnv, HOME: home } }
  );
  assert.equal(code, 0, stderr);

  const names = await runCmd("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: tmp });
  assert.equal(names.code, 0);
  const committedFiles = names.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(committedFiles.includes("tracked.txt"));
  assert.equal(
    committedFiles.some((filePath) => filePath === "loopy" || filePath.startsWith("loopy/")),
    false,
    `unexpected commit contents:\n${committedFiles.join("\n")}`
  );

  const status = await runCmd("git", ["status", "--porcelain"], { cwd: tmp });
  assert.equal(status.code, 0);
  assert.match(status.stdout, /\?\? loopy\//);
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
  assert.match(stderr, /--prompt/i);
});
