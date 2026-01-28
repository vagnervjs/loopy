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

async function promptSelect(question, options, { defaultValue } = {}) {
  const normalizedOptions = (options || [])
    .map((option) => {
      if (!option) return null;
      if (typeof option === "string") return { label: option, value: option };
      const label = option.label != null ? String(option.label) : "";
      const value = option.value != null ? String(option.value) : "";
      if (!label && !value) return null;
      return { label: label || value, value: value || label };
    })
    .filter(Boolean);
  const fallback = defaultValue == null ? "" : String(defaultValue).trim();
  if (!normalizedOptions.length) return fallback;
  if (!process.stdin.isTTY) {
    return fallback || normalizedOptions[0].value;
  }
  const defaultIndex = fallback
    ? normalizedOptions.findIndex((option) => String(option.value) === fallback)
    : -1;

  const header = String(question || "Select an option:").trim();
  if (header) {
    console.log(header);
  }
  for (let i = 0; i < normalizedOptions.length; i += 1) {
    console.log(`  ${i + 1}) ${normalizedOptions[i].label}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const suffix = defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : "";
      const answer = await rl.question(`Select an option${suffix} `);
      const normalized = String(answer || "").trim();
      if (!normalized) {
        if (defaultIndex >= 0) return normalizedOptions[defaultIndex].value;
        return normalizedOptions[0].value;
      }
      const idx = Number.parseInt(normalized, 10);
      if (Number.isFinite(idx) && idx >= 1 && idx <= normalizedOptions.length) {
        return normalizedOptions[idx - 1].value;
      }
      const match = normalizedOptions.find(
        (option) => option.value === normalized || option.label === normalized
      );
      if (match) return match.value;
      console.log(`Invalid selection. Enter a number between 1 and ${normalizedOptions.length}.`);
    }
  } finally {
    rl.close();
  }
}

module.exports = {
  confirm,
  promptLine,
  promptSelect,
};

