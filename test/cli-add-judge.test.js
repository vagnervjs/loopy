const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const { CLI_PATH, runNodeCli } = require("./cli-helpers");

test("add-judge scaffolds review fixture", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-add-judge-"));
  const { code, stderr } = await runNodeCli([CLI_PATH, "add-judge"], { cwd: tmp });
  assert.equal(code, 0);
  assert.equal(stderr, "");

  const modulePath = path.join(tmp, "src", "lib", "llm-review.js");
  const testPath = path.join(tmp, "src", "lib", "llm-review.test.js");
  const moduleStat = await fs.stat(modulePath);
  const testStat = await fs.stat(testPath);
  assert.equal(moduleStat.isFile(), true);
  assert.equal(testStat.isFile(), true);
});
