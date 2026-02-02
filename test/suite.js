const { test } = require("node:test");

function suite(name) {
  const label = String(name || "test").trim() || "test";
  return (title, fn, options) => test(`[${label}] ${title}`, fn, options);
}

module.exports = {
  suite,
};
