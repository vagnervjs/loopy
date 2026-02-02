const fs = require("fs/promises");
const nodeFs = require("fs");

const { prettyPath, resolveFrom } = require("../config");
const { normalizeTaskSeedText } = require("../text");

async function readStdinText() {
  // Prefer reading from the stdin stream to work reliably with `spawn(..., { stdio: ["pipe", ...] })`
  // (which is how our tests provide stdin). Reading fd 0 synchronously can return empty on some
  // platforms if the pipe is not ready yet.
  const stdin = process.stdin;
  if (!stdin) return "";
  if (stdin.isTTY) return "";

  let out = "";
  const drain = () => {
    try {
      let chunk = null;
      while ((chunk = stdin.read()) !== null) out += String(chunk || "");
    } catch (_) {
      // ignore
    }
  };

  try {
    stdin.setEncoding("utf8");
  } catch (_) {
    // ignore
  }

  // Attempt to drain any buffered data immediately (covers some "fast pipe" cases).
  drain();

  // If stdin already looks ended/destroyed, try fd0 as a final fallback.
  if (stdin.readableEnded || stdin.destroyed) {
    if (!String(out || "").trim()) {
      try {
        return nodeFs.readFileSync(0, "utf8");
      } catch (_) {
        // ignore
      }
    }
    return out;
  }

  // Normal case: read from stream events until end/error.
  const streamText = await new Promise((resolve) => {
    const cleanupAndResolve = () => {
      drain();
      try {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
      } catch (_) {
        // ignore
      }
      resolve(out);
    };

    const onData = (chunk) => {
      out += String(chunk || "");
    };
    const onEnd = () => cleanupAndResolve();
    const onError = () => cleanupAndResolve();

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    try {
      stdin.resume();
    } catch (_) {
      // ignore
    }

    // In case it ended between our earlier check and listener attach.
    if (stdin.readableEnded || stdin.destroyed) cleanupAndResolve();
  });

  if (!String(streamText || "").trim()) {
    try {
      return nodeFs.readFileSync(0, "utf8");
    } catch (_) {
      // ignore
    }
  }

  return streamText;
}

async function loadSeedFromFlag(rawValue, { flagName, cwd, stdinText } = {}) {
  const label = "Seed prompt";
  const flag = "--prompt";
  const raw = rawValue == null ? "" : String(rawValue).trim();
  if (!raw) return { seed: "", source: "" };

  if (raw === "-") {
    const rawText = stdinText !== undefined ? stdinText : await readStdinText();
    const seed = normalizeTaskSeedText(rawText);
    if (!seed) throw new Error(`${label} from ${flag} '-' (stdin) is empty.`);
    return { seed, source: flag };
  }

  if (raw.startsWith("@")) {
    const rawPath = raw.slice(1).trim();
    if (!rawPath) throw new Error(`Missing file path after ${flag} @<file>.`);
    const abs = resolveFrom(cwd, rawPath);
    let fileRaw = "";
    try {
      fileRaw = await fs.readFile(abs, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        throw new Error(`${label} file not found: ${prettyPath(cwd, abs)}`);
      }
      if (err && err.code === "EISDIR") {
        throw new Error(`${label} path is a directory: ${prettyPath(cwd, abs)}`);
      }
      if (err && (err.code === "EACCES" || err.code === "EPERM")) {
        throw new Error(`Permission denied reading ${label.toLowerCase()} file: ${prettyPath(cwd, abs)}`);
      }
      throw new Error(
        `Failed to read ${label.toLowerCase()} file ${prettyPath(cwd, abs)}: ${
          err && err.message ? err.message : String(err)
        }`
      );
    }
    const seed = normalizeTaskSeedText(fileRaw);
    if (!seed) throw new Error(`${label} file is empty: ${prettyPath(cwd, abs)}`);
    return { seed, source: flag };
  }

  const seed = normalizeTaskSeedText(raw);
  if (!seed) throw new Error(`${label} from ${flag} is empty.`);
  return { seed, source: flag };
}

async function loadTaskSeed(config, { stdinText } = {}) {
  return loadSeedFromFlag(config.promptSeed, { flagName: "prompt", cwd: config.cwd, stdinText });
}

module.exports = {
  loadTaskSeed,
  readStdinText,
};
