const test = require("node:test");
const assert = require("node:assert/strict");

const { validateConfig } = require("../src/config-validate");

test("validateConfig - rejects invalid mode", () => {
  const flags = {};
  const config = { mode: "invalid" };
  assert.throws(() => {
    validateConfig({ flags, config, defaultMode: "build" });
  }, /Unsupported --mode/);
});

test("validateConfig - rejects resume with seed flags", () => {
  const flags = { prompt: "hello" };
  const config = { mode: "build", resume: true };
  assert.throws(() => {
    validateConfig({
      flags,
      config,
      promptSeedProvided: true,
      defaultMode: "build",
    });
  }, /--resume/);
});

test("validateConfig - rejects missing prompt value", () => {
  const flags = { prompt: true };
  const config = { mode: "build" };
  assert.throws(() => {
    validateConfig({ flags, config, defaultMode: "build" });
  }, /Missing value for --prompt/);
});
