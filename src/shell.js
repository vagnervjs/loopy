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

function buildScriptCommand(command, inputFile) {
  if (process.platform === "win32") return null;
  const { shell, args } = buildShellCommand(command, inputFile);
  return { cmd: "script", args: ["-q", "/dev/null", shell, ...args] };
}

async function runShellCommand(command, input, maxOutputBytes, options = {}) {
  const limit = maxOutputBytes || DEFAULTS.maxOutputBytes;
  const cwd = options && options.cwd ? options.cwd : undefined;
  const agentStreamLogPath =
    options && options.agentStreamLogPath ? String(options.agentStreamLogPath) : "";
  const streamToTerminal = Boolean(options && options.streamToTerminal);
  // Only require a PTY when explicitly streaming to the terminal.
  // Logging output to a file should work reliably with normal pipes.
  const usePty = Boolean(streamToTerminal);

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

  if (usePty) {
    const pty = loadPty();
    if (pty) {
      const { shell, args } = buildShellCommand(command);
      let child = null;
      try {
        child = pty.spawn(shell, args, {
          name: "xterm-color",
          cols: 120,
          rows: 40,
          cwd: cwd || process.cwd(),
          env: process.env,
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
  }

  let inputFile = null;
  if (usePty && input) {
    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-pty-"));
      inputFile = path.join(tmpDir, "prompt.txt");
      await fs.writeFile(inputFile, input, "utf8");
    } catch (_) {
      inputFile = null;
    }
  }

  return new Promise((resolve) => {
    const scriptCommand = usePty ? buildScriptCommand(command, inputFile) : null;
    const spawnTarget = scriptCommand ? scriptCommand.cmd : command;
    const spawnArgs = scriptCommand ? scriptCommand.args : [];
    const child = spawn(spawnTarget, spawnArgs, {
      shell: scriptCommand ? false : true,
      stdio: scriptCommand ? [process.stdin, "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: process.env,
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
        if (inputFile) {
          fs.unlink(inputFile).catch(() => {});
        }
        resolve({ code: 1, stdout, stderr: stderr + err.message });
      });
    });

    child.on("close", (code) => {
      Promise.resolve(appendQueue).finally(() => {
        if (inputFile) {
          fs.unlink(inputFile).catch(() => {});
        }
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });

    if (input && !scriptCommand) {
      child.stdin.write(input);
    }
    if (!scriptCommand) {
      child.stdin.end();
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

