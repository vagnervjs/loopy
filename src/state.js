const { readText } = require("./fs");

async function loadState(stateFile) {
  try {
    const text = await readText(stateFile);
    if (!text) return { state: {}, bytes: 0 };
    return { state: JSON.parse(text), bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { state: {}, bytes: 0 };
  }
}

module.exports = {
  loadState,
};

