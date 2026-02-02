const { test } = require("node:test");

function suite(name) {
  const label = String(name || "test").trim() || "test";
  return (title, options, fn) => {
    if (typeof options === "function") {
      return test(`[${label}] ${title}`, options);
    }

    if (options) {
      return test(`[${label}] ${title}`, options, fn);
    }

    return test(`[${label}] ${title}`, fn);
  };
}

module.exports = {
  suite,
};
