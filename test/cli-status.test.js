const { suite } = require("./suite");
const test = suite("cli-status");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { CLI_PATH, runNodeCli } = require("./cli-helpers");

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
  assert.match(stdout, /📈 Progress/);
  assert.match(stdout, /\[[#-]+\]\s+(n\/a|\d+%)/);
  assert.match(stdout, /Phases:\s+n\/a|Phases:\s+\d+\/\d+/);
  assert.match(stdout, /⏱️\s+Time/);
  assert.match(stdout, /Total duration:/);
  assert.match(stdout, /Elapsed:/);
  assert.match(stdout, /Updated at:\s+2026-01-26T01:16:24.741Z/);
  assert.match(stdout, /ℹ️\s+Details/);
  assert.match(stdout, /Current phase:\s+n\/a/);
  assert.match(stdout, /-\s+Iteration:\s+12/);
  assert.match(stdout, /-\s+Last status:\s+guardrail-stop/);
  assert.match(stdout, /-\s+Last test:\s+n\/a/);
  assert.match(stdout, /-\s+Last error:\s+Repeated failure signature/);
  assert.match(stdout, /-\s+Last hint:\s+Try a different approach\./);
  assert.match(stdout, /-\s+Last hint at:\s+2026-01-26T01:16:00.000Z/);
  assert.match(stdout, /-\s+Hint count:\s+3/);
  assert.match(stdout, /-\s+Last bytes:\s+8856/);
});

test("`status` exits 1 with friendly message when state file is missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-status-missing-"));
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "status"], { cwd: tmp });
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.match(stderr, /No Loopy state found/);
  assert.match(stderr, /Run `loopy`/);
});
