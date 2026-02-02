const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const CLI_PATH = path.resolve(__dirname, "..", "bin", "loopy.js");
const { version: LOOPY_VERSION } = require("../package.json");

function runNodeCli(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runNodeCliWithStdin(args, { cwd, env, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    try {
      child.stdin.write(String(stdin || ""));
    } catch (_) {
      // ignore
    }
    try {
      child.stdin.end();
    } catch (_) {
      // ignore
    }

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runCmd(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args || [], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env || {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function extractHelpDescriptionColumns(helpText, indent) {
  const lines = String(helpText || "").split(/\r?\n/);
  const cols = [];
  for (const line of lines) {
    if (!line.startsWith(`${indent}--`)) continue;
    const m = line.match(/^(\s*)(--.+?)(\s{2,})(\S)/);
    if (!m) continue;
    cols.push(m[1].length + m[2].length + m[3].length);
  }
  return cols;
}

function assertHelpAligned(helpText) {
  const commonCols = extractHelpDescriptionColumns(helpText, "  ");
  assert.ok(commonCols.length >= 2, "expected at least two common option rows");
  assert.equal(new Set(commonCols).size, 1, `common option descriptions misaligned: ${commonCols.join(", ")}`);

  const advancedCols = extractHelpDescriptionColumns(helpText, "  ");
  assert.ok(advancedCols.length >= 2, "expected at least two advanced option rows");
  assert.equal(new Set(advancedCols).size, 1, `advanced option descriptions misaligned: ${advancedCols.join(", ")}`);
}

async function initGitRepo(tmp, { withTask = true } = {}) {
  const gitEnv = {
    GIT_AUTHOR_NAME: "loopy-test",
    GIT_AUTHOR_EMAIL: "loopy-test@example.com",
    GIT_COMMITTER_NAME: "loopy-test",
    GIT_COMMITTER_EMAIL: "loopy-test@example.com",
  };
  await runCmd("git", ["init"], { cwd: tmp });
  await fs.writeFile(
    path.join(tmp, ".gitignore"),
    ["/node_modules", "/.loopy/*", "!/.loopy/LOOPY_PLAN.md"].join("\n") + "\n",
    "utf8"
  );

  if (withTask) {
    await fs.mkdir(path.join(tmp, ".loopy"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".loopy", "LOOPY_PLAN.md"),
      [
        "---",
        "max_iterations: 1",
        "backoff_ms: 0",
        "test_command: node -e \"process.exit(0)\"",
        "---",
        "",
        "# Plan",
        "",
        "- [ ] do something",
        "",
      ].join("\n"),
      "utf8"
    );
  }

  await runCmd("git", ["add", "-A"], { cwd: tmp });
  const commit = await runCmd("git", ["commit", "-m", "init"], { cwd: tmp, env: gitEnv });
  if (commit.code !== 0) throw new Error(`Failed to init git repo: ${commit.stderr || commit.stdout}`);
  return gitEnv;
}

async function writeTestConfig(tmp, { testCommand = "npm test" } = {}) {
  const configPath = path.join(tmp, "config.yml");
  const payload = `test_command: ${testCommand}\n`;
  await fs.writeFile(configPath, payload, "utf8");
  return configPath;
}

module.exports = {
  CLI_PATH,
  LOOPY_VERSION,
  runNodeCli,
  runNodeCliWithStdin,
  runCmd,
  assertHelpAligned,
  initGitRepo,
  writeTestConfig,
};
