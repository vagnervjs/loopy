const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const yaml = require("js-yaml");

const DEFAULTS = {
  taskFile: "RALPH_TASK.md",
  promptFile: "PROMPT.md",
  ralphDir: ".ralph",
  progressFile: ".ralph/progress.md",
  guardrailsFile: ".ralph/guardrails.md",
  activityLog: ".ralph/activity.log",
  agentStreamLog: ".ralph/agent_stream.log",
  stateFile: ".ralph/state.json",
  maxIterations: 50,
  maxMinutes: 120,
  backoffMs: 5000,
  rotateBytes: 150000,
  maxOutputBytes: 1024 * 1024,
  gitCommitMessage: "loopy: {task_summary} (iter {iteration} - {status}, {test})",
};

let stopRequested = false;
let currentActivityLog = DEFAULTS.activityLog;

function resolveFrom(cwd, maybePath) {
  if (!maybePath) return maybePath;
  if (path.isAbsolute(maybePath)) return maybePath;
  return path.resolve(cwd || process.cwd(), maybePath);
}

function materializeConfigPaths(config, cwd) {
  const nextCwd = cwd || config.cwd || process.cwd();
  return {
    ...config,
    cwd: nextCwd,
    taskFile: resolveFrom(nextCwd, config.taskFile),
    promptFile: resolveFrom(nextCwd, config.promptFile),
    ralphDir: resolveFrom(nextCwd, config.ralphDir || DEFAULTS.ralphDir),
    progressFile: resolveFrom(nextCwd, config.progressFile),
    guardrailsFile: resolveFrom(nextCwd, config.guardrailsFile),
    activityLog: resolveFrom(nextCwd, config.activityLog),
    stateFile: resolveFrom(nextCwd, config.stateFile),
  };
}

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

function coerceNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function coerceBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function clampMin(value, minValue) {
  if (!Number.isFinite(value)) return minValue;
  return value < minValue ? minValue : value;
}

function redact(text) {
  if (!text) return "";
  const patterns = [
    /([\w-]*(?:API|TOKEN|SECRET|PASSWORD|PASS|KEY)[\w-]*)(\s*[:=]\s*)([^\n\r]+)/gi,
    /(AKIA|ASIA)[0-9A-Z]{12,}/g,
    /(-----BEGIN[\s\S]+?-----END[\s\S]+?-----)/g,
  ];
  let redacted = text;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match, key, sep) => {
      if (!sep) return "[REDACTED]";
      return `${key}${sep}[REDACTED]`;
    });
  }
  return redacted;
}

function truncate(text, maxBytes) {
  if (!text) return "";
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  const slice = buffer.slice(buffer.length - maxBytes);
  return `...TRUNCATED (${buffer.length - maxBytes} bytes)\n` + slice.toString();
}

async function readText(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return data;
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

async function writeText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function parseTask(text) {
  const result = {
    frontMatter: {},
    body: text,
    checklist: [],
    allChecked: false,
  };

  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (match) {
    try {
      result.frontMatter = yaml.load(match[1]) || {};
    } catch (err) {
      throw new Error(`Failed to parse front matter: ${err.message}`);
    }
    result.body = text.slice(match[0].length);
  }

  const checklist = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const itemMatch = line.match(/^-\s*\[( |x|X)\]\s+(.*)$/);
    if (itemMatch) {
      checklist.push({
        checked: itemMatch[1].toLowerCase() === "x",
        text: itemMatch[2],
      });
    }
  }

  result.checklist = checklist;
  result.allChecked = checklist.length > 0 && checklist.every((item) => item.checked);
  return result;
}

function getTaskSummary(text) {
  if (!text) return "task update";
  const parsed = parseTask(text);
  const firstOpen = parsed.checklist.find((item) => !item.checked);
  if (firstOpen && firstOpen.text) return firstOpen.text.trim();
  const firstItem = parsed.checklist[0];
  if (firstItem && firstItem.text) return firstItem.text.trim();
  const bodyLines = (parsed.body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (bodyLines.length) return bodyLines[0];
  return "task update";
}

function formatProgress(state) {
  const lines = [
    "# Loopy Progress",
    "",
    `- Iteration: ${state.iteration || 0}`,
    `- Last status: ${state.lastStatus || "n/a"}`,
    `- Last test: ${state.lastTest || "n/a"}`,
    `- Last error: ${state.lastError || "n/a"}`,
    `- Last bytes: ${state.lastBytes || 0}`,
    `- Rotation pending: ${state.rotatePending ? "yes" : "no"}`,
    `- Started at: ${state.startedAt || "n/a"}`,
    `- Updated at: ${state.updatedAt || "n/a"}`,
  ];

  if (state.history && state.history.length) {
    lines.push("", "## History");
    for (const entry of state.history.slice(-20)) {
      lines.push(`- ${entry}`);
    }
  }

  return lines.join("\n") + "\n";
}

function ensureGuardrails(text) {
  if (!text || !text.trim()) {
    return "# Loopy Guardrails\n\n## Signs\n";
  }
  if (!text.includes("## Signs")) {
    return text.trimEnd() + "\n\n## Signs\n";
  }
  return text;
}

function appendSign(guardrailsText, message) {
  const updated = ensureGuardrails(guardrailsText);
  const line = `- ${new Date().toISOString()} ${message}`;
  return updated.trimEnd() + "\n" + line + "\n";
}

function formatPrompt({ iteration, taskText, guardrailsText, progressText, lastOutput, rotationPending }) {
  const lines = [
    "# Loopy Loop Prompt",
    "",
    `Timestamp: ${new Date().toISOString()}`,
    `Iteration: ${iteration}`,
    `Rotation: ${rotationPending ? "fresh" : "standard"}`,
    "",
    "## Task (RALPH_TASK.md)",
    taskText.trimEnd(),
    "",
    "## Guardrails",
    guardrailsText.trimEnd(),
    "",
    "## Progress",
    progressText.trimEnd(),
  ];

  if (!rotationPending && lastOutput) {
    lines.push("", "## Last Agent Output (truncated)", lastOutput.trimEnd());
  }

  lines.push(
    "",
    "## Instructions",
    "- Follow the task checklist in RALPH_TASK.md.",
    "- Update task checkboxes as you complete items.",
    "- Record any new guardrails if you detect repetition or drift.",
    "- Keep changes focused and maintain repo state.",
    ""
  );

  return lines.join("\n");
}

function normalizeCommand(command) {
  if (!command || typeof command !== "string") return "";
  return command.trim();
}

function formatDuration(minutes) {
  return `${minutes}m`;
}

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
  const usePty = Boolean(agentStreamLogPath || streamToTerminal);

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

function renderTemplate(template, vars) {
  const input = template == null ? "" : String(template);
  const replaced = input.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
    return value == null ? "" : String(value);
  });
  // Avoid accidental newlines in `git commit -m`.
  return replaced.replace(/\r?\n/g, " ").trim();
}

async function git(args, { cwd, maxOutputBytes } = {}) {
  return runProcess("git", args, { cwd, maxOutputBytes: maxOutputBytes || DEFAULTS.maxOutputBytes });
}

async function ensureGitRepo(cwd) {
  const res = await git(["rev-parse", "--show-toplevel"], { cwd });
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(msg || "Not a git repository.");
  }
  return res.stdout.trim();
}

async function gitStatusPorcelain(cwd) {
  const res = await git(["status", "--porcelain"], { cwd });
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(msg || "Failed to read git status.");
  }
  return res.stdout;
}

async function gitBranchExistsLocal(cwd, branch) {
  if (!branch) return false;
  const res = await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd });
  return res.code === 0;
}

async function gitSwitchBranch(cwd, branch) {
  if (!branch) return;
  const dirty = (await gitStatusPorcelain(cwd)).trim();
  if (dirty) {
    throw new Error("Refusing to switch branches with uncommitted changes.");
  }
  const exists = await gitBranchExistsLocal(cwd, branch);
  const args = exists ? ["switch", branch] : ["switch", "-c", branch];
  const res = await git(args, { cwd });
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(msg || `Failed to switch to branch: ${branch}`);
  }
}

async function ensureGitWorktree(baseCwd, worktreePath, worktreeBranch) {
  await ensureGitRepo(baseCwd);

  const absPath = resolveFrom(baseCwd, worktreePath);
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${absPath}`);
    }
    // If it exists, assume it's already a worktree (or user-managed). We'll validate by running a git command in it.
    await ensureGitRepo(absPath);
    if (worktreeBranch) {
      await gitSwitchBranch(absPath, worktreeBranch);
    }
    return absPath;
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  const args = ["worktree", "add"];
  if (worktreeBranch) {
    // If the branch exists locally, use it; otherwise create it.
    const exists = await gitBranchExistsLocal(baseCwd, worktreeBranch);
    if (exists) {
      args.push(absPath, worktreeBranch);
    } else {
      args.push("-b", worktreeBranch, absPath);
    }
  } else {
    // Safe default: detached HEAD worktree.
    args.push("--detach", absPath);
  }

  const res = await git(args, { cwd: baseCwd });
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout || "").trim();
    throw new Error(msg || `Failed to create worktree: ${absPath}`);
  }

  return absPath;
}

async function gitCommitIfNeeded(config, { iteration, status, testStatus, taskComplete, taskSummary }) {
  if (!config.gitCommit) return { committed: false, reason: "disabled" };

  await ensureGitRepo(config.cwd);
  const porcelain = await gitStatusPorcelain(config.cwd);
  const hasChanges = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => !line.startsWith("?? .ralph") && !line.startsWith("?? PROMPT.md"));

  if (!hasChanges) return { committed: false, reason: "no-changes" };

  const addRes = await git(["add", "-A"], { cwd: config.cwd });
  if (addRes.code !== 0) {
    const msg = (addRes.stderr || addRes.stdout || "").trim();
    throw new Error(msg || "Failed to stage changes (git add -A).");
  }

  let branch = "";
  try {
    const b = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: config.cwd });
    branch = (b.stdout || "").trim();
  } catch (_) {
    branch = "";
  }

  const message = renderTemplate(config.gitCommitMessage || DEFAULTS.gitCommitMessage, {
    iteration,
    status,
    test: testStatus,
    timestamp: new Date().toISOString(),
    taskComplete: taskComplete ? "true" : "false",
    task_summary: taskSummary,
    branch,
  });

  const commitRes = await git(["commit", "-m", message], { cwd: config.cwd });
  if (commitRes.code !== 0) {
    const msg = (commitRes.stderr || commitRes.stdout || "").trim();
    // Treat "nothing to commit" as benign.
    if (/nothing to commit/i.test(msg)) return { committed: false, reason: "no-changes" };
    throw new Error(msg || "Failed to commit changes.");
  }

  const hashRes = await git(["rev-parse", "--short", "HEAD"], { cwd: config.cwd });
  const hash = hashRes.code === 0 ? (hashRes.stdout || "").trim() : "";
  return { committed: true, hash, message };
}

async function getGitModifiedFiles(cwd) {
  try {
    const { stdout } = await runProcess(
      "git",
      ["status", "--porcelain"],
      { cwd: cwd || process.cwd(), maxOutputBytes: DEFAULTS.maxOutputBytes }
    );
    const files = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3));
    return files;
  } catch (err) {
    return [];
  }
}

function detectThrash(state, files) {
  if (!files || files.length === 0) return { thrash: false, state };
  const signature = files.sort().join(",");
  const newState = { ...state };
  if (newState.lastFileSignature === signature && newState.lastStatus === "failure") {
    newState.fileThrashCount = (newState.fileThrashCount || 1) + 1;
  } else {
    newState.fileThrashCount = 1;
  }
  newState.lastFileSignature = signature;
  return { thrash: newState.fileThrashCount >= 3, state: newState };
}

function detectRepeatFailure(state, errorSignature) {
  if (!errorSignature) return { repeated: false, state };
  const newState = { ...state };
  const counts = { ...(state.errorCounts || {}) };
  counts[errorSignature] = (counts[errorSignature] || 0) + 1;
  newState.errorCounts = counts;
  return { repeated: counts[errorSignature] >= 3, state: newState };
}

async function loadState(stateFile) {
  try {
    const text = await readText(stateFile);
    if (!text) return { state: {}, bytes: 0 };
    return { state: JSON.parse(text), bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { state: {}, bytes: 0 };
  }
}

function mergeConfig(flags, frontMatter) {
  const fm = frontMatter || {};
  const hooks = fm.hooks || {};
  const git = fm.git || {};
  return {
    cwd: process.cwd(),
    taskFile: flags.task || DEFAULTS.taskFile,
    promptFile: flags.prompt || DEFAULTS.promptFile,
    ralphDir: DEFAULTS.ralphDir,
    progressFile: flags.progress || DEFAULTS.progressFile,
    guardrailsFile: flags.guardrails || DEFAULTS.guardrailsFile,
    activityLog: flags["activity-log"] || DEFAULTS.activityLog,
    agentStreamLog: DEFAULTS.agentStreamLog,
    stateFile: flags.state || DEFAULTS.stateFile,
    agentCommand: normalizeCommand(flags["agent-cmd"] || fm.agent_command || fm.agentCommand || ""),
    testCommand: normalizeCommand(fm.test_command || fm.testCommand || ""),
    preIteration: normalizeCommand(fm.preIteration || fm.pre_iteration || hooks.preIteration || ""),
    postIteration: normalizeCommand(fm.postIteration || fm.post_iteration || hooks.postIteration || ""),
    onFailure: normalizeCommand(fm.onFailure || fm.on_failure || hooks.onFailure || ""),
    gitBranch:
      flags["git-branch"] ||
      fm.git_branch ||
      fm.gitBranch ||
      git.branch ||
      git.git_branch ||
      git.gitBranch ||
      "",
    gitCommit: coerceBoolean(flags["git-commit"] ?? fm.git_commit ?? fm.gitCommit ?? git.commit ?? git.git_commit),
    gitCommitMessage:
      flags["git-commit-message"] ||
      fm.git_commit_message ||
      fm.gitCommitMessage ||
      git.commit_message ||
      git.commitMessage ||
      DEFAULTS.gitCommitMessage,
    gitWorktree:
      flags["git-worktree"] ||
      fm.git_worktree ||
      fm.gitWorktree ||
      git.worktree ||
      git.git_worktree ||
      "",
    gitWorktreeBranch:
      flags["git-worktree-branch"] ||
      fm.git_worktree_branch ||
      fm.gitWorktreeBranch ||
      git.worktree_branch ||
      git.worktreeBranch ||
      "",
    maxIterations: clampMin(
      coerceNumber(flags["max-iterations"] || fm.max_iterations, DEFAULTS.maxIterations),
      1
    ),
    maxMinutes: clampMin(
      coerceNumber(flags["max-minutes"] || fm.max_minutes, DEFAULTS.maxMinutes),
      1
    ),
    backoffMs: clampMin(
      coerceNumber(flags["backoff-ms"] || fm.backoff_ms, DEFAULTS.backoffMs),
      0
    ),
    rotateBytes: clampMin(
      coerceNumber(flags["rotate-bytes"] || fm.rotate_bytes, DEFAULTS.rotateBytes),
      1024
    ),
    dryRun: Boolean(flags["dry-run"]),
    stream: Boolean(flags.stream),
  };
}

async function appendActivity(logPath, lines) {
  const payload = lines.map((line) => `[${new Date().toISOString()}] ${line}`).join("\n") + "\n";
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, payload, "utf8");
}

async function runIteration(config) {
  let bytesRead = 0;
  let bytesWritten = 0;
  const guardrailStopReasons = [];

  const taskText = await readText(config.taskFile);
  bytesRead += Buffer.byteLength(taskText);
  if (!taskText) {
    throw new Error(`Missing ${config.taskFile}.`);
  }

  const parsedTask = parseTask(taskText);

  if (parsedTask.allChecked) {
    await appendActivity(config.activityLog, ["Task complete. Stopping loop."]);
    return { status: "complete", bytes: 0 };
  }

  let guardrailsText = await readText(config.guardrailsFile);
  bytesRead += Buffer.byteLength(guardrailsText);

  const ensuredGuardrails = ensureGuardrails(guardrailsText);
  if (ensuredGuardrails !== guardrailsText) {
    await writeText(config.guardrailsFile, ensuredGuardrails);
    bytesWritten += Buffer.byteLength(ensuredGuardrails);
    guardrailsText = ensuredGuardrails;
  }

  const progressText = await readText(config.progressFile);
  bytesRead += Buffer.byteLength(progressText);

  const loaded = await loadState(config.stateFile);
  const state = loaded.state;
  bytesRead += loaded.bytes;

  const iteration = (state.iteration || 0) + 1;
  const rotationPending = Boolean(state.rotatePending);

  const lastOutputRaw = rotationPending ? "" : await readText(path.join(config.ralphDir, "last_agent_output.txt"));
  bytesRead += Buffer.byteLength(lastOutputRaw);
  const lastOutput = truncate(lastOutputRaw, 4000);

  const prompt = formatPrompt({
    iteration,
    taskText,
    guardrailsText,
    progressText: progressText || "(no progress recorded yet)",
    lastOutput,
    rotationPending,
  });

  await writeText(config.promptFile, prompt);
  bytesWritten += Buffer.byteLength(prompt);

  await appendActivity(config.activityLog, [
    `Iteration ${iteration} start`,
    `Rotation pending: ${rotationPending ? "yes" : "no"}`,
  ]);

  if (config.dryRun) {
    await appendActivity(config.activityLog, ["Dry run enabled. Skipping agent execution."]);
    return { status: "dry-run", bytes: bytesRead + bytesWritten };
  }

  if (!config.agentCommand) {
    throw new Error("Missing agent_command. Set it in RALPH_TASK.md front matter or use --agent-cmd.");
  }

  if (config.preIteration) {
    const hookResult = await runShellCommand(config.preIteration, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    await appendActivity(config.activityLog, [
      `preIteration hook exit ${hookResult.code}`,
    ]);
  }

  const agentStreamLogPath = config.agentStreamLog
    ? resolveFrom(config.cwd, config.agentStreamLog)
    : path.join(config.ralphDir, "agent_stream.log");

  // Write a small header so runs are easy to separate.
  await fs.mkdir(path.dirname(agentStreamLogPath), { recursive: true });
  await fs.appendFile(
    agentStreamLogPath,
    `\n\n===== Iteration ${iteration} @ ${new Date().toISOString()} =====\n$ ${redact(
      config.agentCommand
    )}\n\n`,
    "utf8"
  );

  const agentResult = await runShellCommand(config.agentCommand, prompt, DEFAULTS.maxOutputBytes, {
    cwd: config.cwd,
    agentStreamLogPath,
    streamToTerminal: Boolean(config.stream),
  });
  const redactedStdout = redact(agentResult.stdout);
  const redactedStderr = redact(agentResult.stderr);
  const combinedOutput = truncate(`${redactedStdout}\n${redactedStderr}`, DEFAULTS.maxOutputBytes);

  await writeText(path.join(config.ralphDir, "last_agent_output.txt"), combinedOutput);
  bytesWritten += Buffer.byteLength(combinedOutput);

  let status = agentResult.code === 0 ? "success" : "failure";
  let lastError = "";
  let errorSignature = "";

  if (status === "failure") {
    const firstErrorLine = (redactedStderr || redactedStdout).split(/\r?\n/).find(Boolean) || "unknown";
    lastError = firstErrorLine;
    errorSignature = `${config.agentCommand}::${firstErrorLine}`;
  }

  let testStatus = "n/a";
  if (status === "success" && config.testCommand) {
    const testResult = await runShellCommand(config.testCommand, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    const testOutput = truncate(redact(`${testResult.stdout}\n${testResult.stderr}`), DEFAULTS.maxOutputBytes);
    await writeText(path.join(config.ralphDir, "last_test_output.txt"), testOutput);
    bytesWritten += Buffer.byteLength(testOutput);
    const testOutcome = testResult.code === 0 ? "pass" : "fail";
    testStatus = `${testOutcome} @ ${new Date().toISOString()}`;
    if (testOutcome === "fail") {
      status = "failure";
      lastError = testOutput.split(/\r?\n/).find(Boolean) || "test failure";
      errorSignature = `${config.testCommand}::${lastError}`;
    }
  }

  const taskAfter = await readText(config.taskFile);
  bytesRead += Buffer.byteLength(taskAfter);
  const taskComplete = taskAfter ? parseTask(taskAfter).allChecked : false;
  const taskSummary = getTaskSummary(taskAfter || taskText);

  let postIterationRan = false;
  if (status === "success" && config.postIteration) {
    const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    postIterationRan = true;
    await appendActivity(config.activityLog, [`postIteration hook exit ${hookResult.code}`]);
  }

  if (status === "success") {
    try {
      const commitResult = await gitCommitIfNeeded(config, {
        iteration,
        status,
        testStatus,
        taskComplete,
        taskSummary,
      });
      if (commitResult.committed) {
        await appendActivity(config.activityLog, [
          `git commit: ${commitResult.hash || "(unknown hash)"} ${commitResult.message}`,
        ]);
      }
    } catch (err) {
      status = "failure";
      lastError = err && err.message ? err.message : String(err);
      errorSignature = `git commit::${lastError}`;
    }
  }

  if (status === "failure" && config.onFailure) {
    const hookResult = await runShellCommand(config.onFailure, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    await appendActivity(config.activityLog, [
      `onFailure hook exit ${hookResult.code}`,
    ]);
  }

  if (!postIterationRan && config.postIteration) {
    const hookResult = await runShellCommand(config.postIteration, "", DEFAULTS.maxOutputBytes, {
      cwd: config.cwd,
    });
    await appendActivity(config.activityLog, [
      `postIteration hook exit ${hookResult.code}`,
    ]);
  }

  const modifiedFiles = await getGitModifiedFiles(config.cwd);
  let nextState = {
    ...state,
    iteration,
    lastStatus: taskComplete ? "complete" : status,
    lastTest: testStatus,
    lastError: lastError || state.lastError || "",
    lastBytes: bytesRead + bytesWritten,
    rotatePending: false,
    updatedAt: new Date().toISOString(),
    startedAt: state.startedAt || new Date().toISOString(),
    history: state.history || [],
  };

  const historyEntry = `${nextState.updatedAt} iteration ${iteration} ${status} (test: ${testStatus})`;
  nextState.history = [...nextState.history, historyEntry].slice(-50);

  if (status === "failure") {
    const repeat = detectRepeatFailure(nextState, errorSignature);
    nextState = repeat.state;

    const thrashCheck = detectThrash(nextState, modifiedFiles);
    nextState = thrashCheck.state;

    let guardrailsUpdated = guardrailsText;

    if (repeat.repeated) {
      guardrailsUpdated = appendSign(
        guardrailsUpdated,
        `Repeated failure signature: ${errorSignature}`
      );
      guardrailStopReasons.push("Repeated failure signature (>= 3).");
    }

    if (thrashCheck.thrash) {
      guardrailsUpdated = appendSign(
        guardrailsUpdated,
        `File thrashing detected: ${modifiedFiles.join(", ")}`
      );
      guardrailStopReasons.push("File thrashing detected (>= 3).");
    }

    if (guardrailsUpdated !== guardrailsText) {
      await writeText(config.guardrailsFile, guardrailsUpdated);
      bytesWritten += Buffer.byteLength(guardrailsUpdated);
    }
  }

  const guardrailStopReason = guardrailStopReasons.join(" ");
  if (guardrailStopReason) {
    nextState.lastStatus = "guardrail-stop";
    nextState.lastError = guardrailStopReason;
  }

  if (bytesRead + bytesWritten >= config.rotateBytes) {
    nextState.rotatePending = true;
  }

  const progressPayload = formatProgress(nextState);
  await writeText(config.progressFile, progressPayload);
  bytesWritten += Buffer.byteLength(progressPayload);

  const statePayload = JSON.stringify(nextState, null, 2) + "\n";
  await writeText(config.stateFile, statePayload);
  bytesWritten += Buffer.byteLength(statePayload);

  await appendActivity(config.activityLog, [
    `Iteration ${iteration} ${status}`,
    `Bytes read/written: ${bytesRead}/${bytesWritten}`,
  ]);

  if (taskComplete) {
    await appendActivity(config.activityLog, ["Task complete detected after iteration."]);
    return { status: "complete", bytes: bytesRead + bytesWritten };
  }

  return { status, bytes: bytesRead + bytesWritten, guardrailStopReason };
}

async function runLoop(command, flags) {
  const baseCwd = process.cwd();
  const initialTaskPath = resolveFrom(baseCwd, flags.task || DEFAULTS.taskFile);
  const taskText = await readText(initialTaskPath);
  const parsedTask = taskText ? parseTask(taskText) : { frontMatter: {} };
  let config = mergeConfig(flags, parsedTask.frontMatter);

  // Optional git workspace setup (worktree / branch). This is done once, before the loop.
  let effectiveCwd = baseCwd;
  if (config.gitWorktree) {
    effectiveCwd = await ensureGitWorktree(baseCwd, config.gitWorktree, config.gitWorktreeBranch);
  }
  if (config.gitBranch) {
    await ensureGitRepo(effectiveCwd);
    await gitSwitchBranch(effectiveCwd, config.gitBranch);
  }

  config = materializeConfigPaths(config, effectiveCwd);
  currentActivityLog = config.activityLog;

  const start = Date.now();
  let iteration = 0;

  while (!stopRequested) {
    const elapsedMinutes = (Date.now() - start) / 60000;
    if (iteration >= config.maxIterations) {
      await appendActivity(config.activityLog, ["Max iterations reached. Stopping."]);
      break;
    }
    if (elapsedMinutes >= config.maxMinutes) {
      await appendActivity(config.activityLog, [
        `Max wall time reached (${formatDuration(config.maxMinutes)}). Stopping.`,
      ]);
      break;
    }

    const result = await runIteration(config);
    iteration += 1;

    if (result.status === "complete") {
      break;
    }

    if (result.guardrailStopReason) {
      await appendActivity(config.activityLog, [
        `Guardrail stop triggered: ${result.guardrailStopReason}`,
      ]);
      break;
    }

    if (stopRequested) {
      await appendActivity(config.activityLog, ["Stop requested. Exiting loop."]);
      break;
    }

    if (command === "run") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, config.backoffMs));
  }

  if (stopRequested) {
    const loaded = await loadState(config.stateFile);
    const state = loaded.state || {};
    const stoppedState = {
      ...state,
      lastStatus: "stopped",
      updatedAt: new Date().toISOString(),
      startedAt: state.startedAt || new Date().toISOString(),
      history: (state.history || [])
        .concat([`${new Date().toISOString()} stopped by signal`])
        .slice(-50),
    };
    const progressPayload = formatProgress(stoppedState);
    await writeText(config.progressFile, progressPayload);
    await writeText(config.stateFile, JSON.stringify(stoppedState, null, 2) + "\n");
    await appendActivity(config.activityLog, ["Final status: stopped."]);
  }
}

function printHelp() {
  const lines = [
    "Loopy",
    "",
    "Usage:",
    "  loopy run [options]",
    "  loopy loop [options]",
    "  loopy status [options]",
    "  loopy help",
    "",
    "Options:",
    "  --task <file>           Task file (default: RALPH_TASK.md)",
    "  --prompt <file>         Prompt file (default: PROMPT.md)",
    "  --progress <file>       Progress file (default: .ralph/progress.md)",
    "  --guardrails <file>     Guardrails file (default: .ralph/guardrails.md)",
    "  --activity-log <file>   Activity log (default: .ralph/activity.log)",
    "  --state <file>          State file (default: .ralph/state.json)",
    "  --agent-cmd <command>   Agent command (overrides task front matter)",
    "  --stream                Mirror agent stdout/stderr to your terminal",
    "  --git-worktree <path>   Use/create git worktree at path (optional)",
    "  --git-worktree-branch <name>  Branch for worktree add/checkout (optional)",
    "  --git-branch <name>     Create/checkout branch before iteration (optional)",
    "  --git-commit            Commit changes after successful iteration (optional)",
    "  --git-commit-message <template>  Commit message template (default shown below)",
    "  --max-iterations <n>    Max iterations (default: 50)",
    "  --max-minutes <n>       Max wall time in minutes (default: 120)",
    "  --backoff-ms <n>        Backoff between iterations (default: 5000)",
    "  --rotate-bytes <n>      Bytes threshold for rotation (default: 150000)",
    "  --dry-run               Build prompt, skip agent execution",
    "  --help, -h              Show help",
    "",
    `Default commit template: ${DEFAULTS.gitCommitMessage}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function runStatus(flags) {
  const cwd = process.cwd();
  const stateFile = resolveFrom(cwd, flags.state || DEFAULTS.stateFile);

  let text = "";
  try {
    text = await fs.readFile(stateFile, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.error(
        `No Loopy state found at ${path.relative(cwd, stateFile) || stateFile}.\n` +
          "Run `loopy run` or `loopy loop` first."
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  let state = null;
  try {
    state = JSON.parse(text);
  } catch (err) {
    console.error(
      `Failed to parse Loopy state at ${path.relative(cwd, stateFile) || stateFile}: ${
        err && err.message ? err.message : String(err)
      }`
    );
    process.exitCode = 1;
    return;
  }

  const lines = [
    `Loopy status (${path.relative(cwd, stateFile) || stateFile})`,
    "",
    `Iteration: ${state && state.iteration != null ? state.iteration : 0}`,
    `Last status: ${(state && state.lastStatus) || "n/a"}`,
    `Last test: ${(state && state.lastTest) || "n/a"}`,
    `Last error: ${(state && state.lastError) || "n/a"}`,
    `Last bytes: ${state && state.lastBytes != null ? state.lastBytes : 0}`,
    `Updated at: ${(state && state.updatedAt) || "n/a"}`,
    "",
  ];
  console.log(lines.join("\n"));
}

async function runCli(argv) {
  const { command, flags } = parseArgs(argv);

  if (!command || flags.help || command === "help") {
    printHelp();
    return;
  }

  if (command === "status") {
    await runStatus(flags);
    return;
  }

  if (command !== "run" && command !== "loop") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  process.on("SIGINT", async () => {
    stopRequested = true;
    await appendActivity(currentActivityLog, ["SIGINT received. Stopping."]);
  });

  process.on("SIGTERM", async () => {
    stopRequested = true;
    await appendActivity(currentActivityLog, ["SIGTERM received. Stopping."]);
  });

  await runLoop(command, flags);
}

module.exports = {
  runCli,
};
