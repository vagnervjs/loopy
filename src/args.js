function parseArgs(argv) {
  const flags = {};
  let command = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h" || arg === "-?" || arg === "/?") {
      flags.help = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      if (value !== undefined) {
        flags[key] = value;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
    } else if (!command) {
      command = arg;
    } else {
      flags._ = flags._ || [];
      flags._.push(arg);
    }
  }

  return { command, flags };
}

module.exports = {
  parseArgs,
};
