const fs = require("fs/promises");
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

async function runShellCommand(command, input, maxOutputBytes, options = {}) {
  const limit = maxOutputBytes || DEFAULTS.maxOutputBytes;
  const cwd = options && options.cwd ? options.cwd : undefined;
  const agentStreamLogPath =
    options && options.agentStreamLogPath ? String(options.agentStreamLogPath) : "";
  const streamToTerminal = Boolean(options && options.streamToTerminal);
  const hasNoColorOption = Object.prototype.hasOwnProperty.call(options || {}, "noColor");
  const noColor = hasNoColorOption
    ? Boolean(options.noColor)
    : Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  const baseEnv = { ...(process.env || {}), ...(options && options.env ? options.env : {}) };
  const childEnv = applyNoColorEnv(baseEnv, noColor);
  // Use a PTY only when it's available (node-pty installed) and streaming was requested.
  // Otherwise fall back to normal pipes (more portable; matches test expectations).
  const pty = streamToTerminal && !noColor ? loadPty() : null;

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
    const { shell, args } = buildShellCommand(command);
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

        child.onData((data) => {
          if (streamToTerminal) process.stdout.write(data);
          if (agentStreamLogPath) appendToLog(redact(data));
          if (Buffer.byteLength(stdout) < limit) {
            stdout += data;
          }
        });

        child.onExit(({ exitCode }) => {
          Promise.resolve(appendQueue).finally(() => {
            resolve({ code: exitCode ?? 1, stdout, stderr: "" });
          });
        });

        if (input) {
          child.write(input);
          if (!input.endsWith("\n")) child.write("\n");
          child.write("\x04");
        }
      });
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
    child.stdout.on("data", (chunk) => {
      if (streamToTerminal) process.stdout.write(chunk);
      if (agentStreamLogPath) appendToLog(redact(chunk.toString()));
      if (Buffer.byteLength(stdout) < limit) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk) => {
      if (streamToTerminal) process.stderr.write(chunk);
      if (agentStreamLogPath) appendToLog(redact(chunk.toString()));
      if (Buffer.byteLength(stderr) < limit) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (err) => {
      Promise.resolve(appendQueue).finally(() => {
        resolve({ code: 1, stdout, stderr: stderr + err.message });
      });
    });

    child.on("close", (code) => {
      Promise.resolve(appendQueue).finally(() => {
        resolve({ code: code ?? 1, stdout, stderr });
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

