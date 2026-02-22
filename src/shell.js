const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { DEFAULTS } = require("./config");
const { redact } = require("./text");

function loadPty() {
  try {
    // eslint-disable-next-line global-require
    return require("node-pty");
  } catch (_) {
    return null;
  }
}

function shellQuotePosix(value) {
  if (value === "") return "''";
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function applyNoColorEnv(env, noColor) {
  if (!noColor) return env;
  return {
    ...env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  };
}

function buildShellCommand(command, inputFile) {
  if (process.platform === "win32") {
    return { shell: "cmd.exe", args: ["/c", command] };
  }
  let wrappedCommand = command;
  if (inputFile) {
    wrappedCommand = `${command} < ${shellQuotePosix(inputFile)}`;
  }
  const shell = process.env.SHELL || "/bin/bash";
  return { shell, args: ["-lc", wrappedCommand] };
}

async function writeTempInputFile(input) {
  const name = `loopy-input-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const filePath = path.join(os.tmpdir(), name);
  await fs.writeFile(filePath, String(input || ""), "utf8");
  return filePath;
}

async function runShellCommand(command, input, maxOutputBytes, options = {}) {
  const limit = maxOutputBytes || DEFAULTS.maxOutputBytes;
  const cwd = options && options.cwd ? options.cwd : undefined;
  const agentStreamLogPath =
    options && options.agentStreamLogPath ? String(options.agentStreamLogPath) : "";
  const streamToTerminal = Boolean(options && options.streamToTerminal);
  const stopSignal = options && options.stopSignal ? options.stopSignal : null;
  const hasNoColorOption = Object.prototype.hasOwnProperty.call(options || {}, "noColor");
  const noColor = hasNoColorOption
    ? Boolean(options.noColor)
    : Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  const baseEnv = { ...(process.env || {}), ...(options && options.env ? options.env : {}) };
  const childEnv = applyNoColorEnv(baseEnv, noColor);
  // Use a PTY only when it's available (node-pty installed) and streaming was requested.
  // Otherwise fall back to normal pipes (more portable; matches test expectations).
  const pty = streamToTerminal && !noColor ? loadPty() : null;

  if (stopSignal && stopSignal.stopRequested) {
    return { code: 130, stdout: "", stderr: "", aborted: true, abortReason: "stop" };
  }

  let aborted = false;
  let abortReason = "";
  let stopUnsubscribe = null;
  let abortTimer = null;
  let killTimer = null;

  const cleanupStop = () => {
    if (stopUnsubscribe) {
      try {
        stopUnsubscribe();
      } catch (_) {
        // ignore
      }
      stopUnsubscribe = null;
    }
    if (abortTimer) {
      clearTimeout(abortTimer);
      abortTimer = null;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const requestAbort = (child, reason) => {
    const nextReason = reason == null ? "" : String(reason);
    if (nextReason && !abortReason) abortReason = nextReason;
    if (aborted) return;
    aborted = true;
    if (!abortReason) abortReason = "stop";
    if (!child || typeof child.kill !== "function") return;
    try {
      child.kill("SIGINT");
    } catch (_) {
      // ignore
    }
    abortTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (_) {
        // ignore
      }
    }, 2000);
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {
        // ignore
      }
    }, 8000);
  };

  const attachStopListener = (child) => {
    if (!stopSignal) return;
    if (stopSignal.stopRequested) {
      requestAbort(child, "stop");
      return;
    }
    if (typeof stopSignal.onStop === "function") {
      stopUnsubscribe = stopSignal.onStop((reason) => requestAbort(child, reason));
      return;
    }
    const interval = setInterval(() => {
      if (stopSignal.stopRequested) {
        clearInterval(interval);
        requestAbort(child, "stop");
      }
    }, 250);
    stopUnsubscribe = () => clearInterval(interval);
  };

  let appendQueue = Promise.resolve();
  const appendToLog = (payload) => {
    if (!agentStreamLogPath) return;
    appendQueue = appendQueue
      .then(() => fs.appendFile(agentStreamLogPath, payload, "utf8"))
      .catch(() => {
        // If log writes fail, keep running the command.
      });
  };

  if (agentStreamLogPath) {
    try {
      await fs.mkdir(path.dirname(agentStreamLogPath), { recursive: true });
    } catch (_) {
      // ignore
    }
  }

  if (pty) {
    let inputFile = "";
    if (input) {
      try {
        inputFile = await writeTempInputFile(input);
      } catch (_) {
        inputFile = "";
      }
    }
    const { shell, args } = buildShellCommand(command, inputFile || "");
    let child = null;
    try {
      child = pty.spawn(shell, args, {
        name: "xterm-color",
        cols: 120,
        rows: 40,
        cwd: cwd || process.cwd(),
        env: childEnv,
      });
    } catch (_) {
      child = null;
    }

    if (child) {
      return new Promise((resolve) => {
        let stdout = "";
        const cleanupInputFile = () => {
          if (!inputFile) return Promise.resolve();
          const target = inputFile;
          inputFile = "";
          return fs.rm(target, { force: true }).catch(() => {});
        };

        attachStopListener(child);
        child.onData((data) => {
          if (streamToTerminal) process.stdout.write(data);
          if (agentStreamLogPath) appendToLog(redact(data));
          if (Buffer.byteLength(stdout) < limit) {
            stdout += data;
          }
        });

        child.onExit(({ exitCode }) => {
          cleanupStop();
          Promise.resolve(appendQueue).finally(() => {
            Promise.resolve(cleanupInputFile()).finally(() => {
              resolve({ code: exitCode ?? 1, stdout, stderr: "", aborted, abortReason });
            });
          });
        });
      });
    }
    if (inputFile) {
      try {
        await fs.rm(inputFile, { force: true });
      } catch (_) {
        // ignore
      }
    }
  }

  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      cwd: cwd || process.cwd(),
    });

    let stdout = "";
    let stderr = "";
    attachStopListener(child);
    child.stdout.on("data", (chunk) => {
      if (streamToTerminal) {
        try {
          process.stdout.write(chunk);
        } catch (err) {
          if (!(err && err.code === "EPIPE")) throw err;
        }
      }
      if (agentStreamLogPath) appendToLog(redact(chunk.toString()));
      if (Buffer.byteLength(stdout) < limit) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk) => {
      if (streamToTerminal) {
        try {
          process.stderr.write(chunk);
        } catch (err) {
          if (!(err && err.code === "EPIPE")) throw err;
        }
      }
      if (agentStreamLogPath) appendToLog(redact(chunk.toString()));
      if (Buffer.byteLength(stderr) < limit) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err) => {
      cleanupStop();
      Promise.resolve(appendQueue).finally(() => {
        resolve({ code: 1, stdout, stderr: stderr + err.message, aborted, abortReason });
      });
    });

    child.on("close", (code) => {
      cleanupStop();
      Promise.resolve(appendQueue).finally(() => {
        resolve({ code: code ?? 1, stdout, stderr, aborted, abortReason });
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    try {
      child.stdin.end();
    } catch (_) {
      // ignore
    }
  });
}

async function runProcess(command, args, { cwd, input, maxOutputBytes } = {}) {
  const limit = maxOutputBytes || DEFAULTS.maxOutputBytes;
  return new Promise((resolve) => {
    const child = spawn(command, args || [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: cwd || process.cwd(),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout) < limit) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) < limit) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: stderr + err.message });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

module.exports = {
  runShellCommand,
  runProcess,
};
