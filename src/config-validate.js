function validateFlags(flags) {
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

  // No legacy flag compatibility: fail fast with a clear message.
  if (hasOwn(flags, "task")) throw new Error("Unsupported legacy flag provided. Use `--plan <file>` instead.");
  if (hasOwn(flags, "agent-cmd")) throw new Error("Unsupported legacy flag provided. Use `--agent <command>` instead.");
  if (hasOwn(flags, "task-prompt"))
    throw new Error("Unsupported legacy seed flag provided. Use `--prompt \"<text>\"` instead.");
  if (hasOwn(flags, "task-file") || hasOwn(flags, "task-prompt-file"))
    throw new Error("Unsupported legacy seed flag provided. Use `--prompt @<file>` (or `--prompt -`) instead.");
  if (hasOwn(flags, "prompt-file")) throw new Error("Unsupported legacy flag provided. Use `--prompt-out <file>` instead.");
  if (hasOwn(flags, "continue")) throw new Error("Unsupported legacy flag provided. Use `--resume` instead.");

  // Validate seed prompt flag early.
  if (hasOwn(flags, "prompt")) {
    if (flags.prompt === true) {
      throw new Error("Missing value for --prompt (expected text, @<file>, or '-').");
    }
    const v = String(flags.prompt || "").trim();
    if (!v) throw new Error("Missing value for --prompt (expected text, @<file>, or '-').");
    if (v.startsWith("@") && !v.slice(1).trim()) {
      throw new Error("Missing file path after --prompt @<file>.");
    }
  }

  // Validate plan seed flag early.
  if (hasOwn(flags, "plan")) {
    if (flags.plan === true) {
      throw new Error("Missing value for --plan (expected text, @<file>, or '-').");
    }
    const v = String(flags.plan || "").trim();
    if (!v) throw new Error("Missing value for --plan (expected text, @<file>, or '-').");
    if (v.startsWith("@") && !v.slice(1).trim()) {
      throw new Error("Missing file path after --plan @<file>.");
    }
  }

  // Validate prompt output flag.
  if (flags["prompt-out"] === true) {
    throw new Error("Missing value for --prompt-out (expected a file path).");
  }

  if (flags.mode === true) {
    throw new Error("Missing value for --mode (expected 'build' or 'plan').");
  }

  if (flags["prompt-template"] === true) {
    throw new Error("Missing value for --prompt-template (expected a file path).");
  }

  if (flags["plan-file"] === true || flags["plan-doc"] === true) {
    throw new Error("Missing value for --plan-file (expected a file path).");
  }
}

function validateConfig({ flags, config, planSeedProvided, promptSeedProvided, defaultMode } = {}) {
  validateFlags(flags || {});
  const normalizedMode = String((config && config.mode) || defaultMode || "").trim().toLowerCase();
  if (!normalizedMode) {
    throw new Error("Missing mode (expected 'build' or 'plan').");
  }
  if (!["build", "plan"].includes(normalizedMode)) {
    throw new Error(`Unsupported --mode "${config.mode}" (expected 'build' or 'plan').`);
  }
  if (config) {
    config.mode = normalizedMode;
  }

  // `--resume` is a "resume only" mode: don't accept seed prompt updates here.
  if (config && config.resume && (promptSeedProvided || planSeedProvided)) {
    throw new Error(
      "`--resume` cannot be used with `--prompt` or `--plan`. Omit them to resume, or run without `--resume`."
    );
  }

  return config;
}

module.exports = {
  validateConfig,
};
