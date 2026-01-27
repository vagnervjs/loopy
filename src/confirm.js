const readline = require("node:readline/promises");

async function confirm(question, { autoApply = false, defaultYes = false } = {}) {
  if (autoApply) return true;
  if (!process.stdin.isTTY) return false;

  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} ${suffix} `);
    const normalized = String(answer || "").trim().toLowerCase();
    if (!normalized) return Boolean(defaultYes);
    if (["y", "yes"].includes(normalized)) return true;
    if (["n", "no"].includes(normalized)) return false;
    return Boolean(defaultYes);
  } finally {
    rl.close();
  }
}

async function promptLine(question) {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return String(answer || "").trim();
  } finally {
    rl.close();
  }
}

module.exports = {
  confirm,
  promptLine,
};

