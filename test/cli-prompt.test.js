const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli, runNodeCliWithStdin } = require("./cli-helpers");

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

test("unsupported legacy seed flag exits 1", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-legacy-seed-"));
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--dry-run", "--task-prompt", "build a thing"], {
    cwd: tmp,
  });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /Unsupported legacy seed flag/i);
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
