const readline = require("node:readline/promises");

async function confirm(question, { confirm = false, defaultYes = false } = {}) {
  if (!confirm) return true;
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

async function promptLine(question, { defaultValue } = {}) {
  const fallback = defaultValue == null ? "" : String(defaultValue).trim();
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const base = String(question || "").trimEnd();
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = await rl.question(`${base}${suffix} `);
    const normalized = String(answer || "").trim();
    return normalized || fallback;
  } finally {
    rl.close();
  }
}

module.exports = {
  confirm,
  promptLine,
};

