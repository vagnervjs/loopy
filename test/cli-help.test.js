const test = require("node:test");
const assert = require("node:assert/strict");

const { CLI_PATH, LOOPY_VERSION, runNodeCli, assertHelpAligned } = require("./cli-helpers");

test("`--help` prints usage and exits 0", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "--help"]);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /\bloopy help\b/);
  assert.match(stdout, /--continue\b/);
  assert.match(stdout, /--no-emoji\b/);
  assert.match(stdout, /--plain\b/);
  assert.match(stdout, /--verbose\b/);
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
  assert.match(stdout, /--no-emoji\b/);
  assert.match(stdout, /--plain\b/);
  assert.match(stdout, /--verbose\b/);
  assert.match(
    stdout,
    /--git-commit-message <template>\s+Commit message template \(default: loopy: \{change_type\} \{task_summary\}\)/
  );
  assert.ok(!/Default commit template:/i.test(stdout));
  assert.ok(!/default shown below/i.test(stdout));
});

test("unknown command exits 1", async () => {
  const { code, stdout, stderr } = await runNodeCli([CLI_PATH, "nope"]);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command/);
  assert.match(stdout, /Usage:/);
});
