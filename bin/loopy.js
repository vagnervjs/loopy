#!/usr/bin/env node

const { runCli } = require("../src/loopy");

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
