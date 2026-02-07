const { readText } = require("./fs");

async function loadState(stateFile) {
  try {
    const text = await readText(stateFile);
    if (!text) return { state: {}, bytes: 0 };
    return { state: JSON.parse(text), bytes: Buffer.byteLength(text) };
  } catch (err) {
    // Distinguish file-not-found (expected on first run) from corrupt JSON
    // so operators know when a state file needs attention.
    if (err && err.code === "ENOENT") {
      return { state: {}, bytes: 0 };
    }
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(
      `[loopy] Warning: failed to load state from ${stateFile}: ${msg}. Starting with empty state.\n`
    );
    return { state: {}, bytes: 0, corrupt: true };
  }
}

module.exports = {
  loadState,
};

