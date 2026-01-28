const fs = require("fs/promises");
const path = require("path");

const { DEFAULTS, resolveFrom } = require("./config");
const { runProcess } = require("./shell");
const { renderTemplate } = require("./text");

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

async function getCurrentBranch(cwd) {
  try {
    const res = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    if (res.code === 0) {
      const branch = res.stdout.trim();
      // Return null for detached HEAD state
      return branch === "HEAD" ? null : branch;
    }
    return null;
  } catch (err) {
    return null;
  }
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

async function gitCommitIfNeeded(
  config,
  { iteration, status, testStatus, taskComplete, taskSummary, changeType } = {}
) {
  if (!config.gitCommit) return { committed: false, reason: "disabled" };

  try {
    await ensureGitRepo(config.cwd);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/not a git repository/i.test(msg)) {
      return { committed: false, reason: "not-git-repo" };
    }
    throw err;
  }
  const porcelain = await gitStatusPorcelain(config.cwd);
  const hasChanges = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      const file = line.slice(3);
      if (file === ".loopy/LOOPY_PLAN.md") return true;
      if (line.startsWith("?? .loopy/")) return false;
      if (line.startsWith("?? .loopy")) return false;
      if (line.startsWith("?? PROMPT.md")) return false;
      if (line.startsWith("?? .loopy/PROMPT.md")) return false;
      return true;
    });

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
    change_type: changeType,
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
    const { stdout } = await runProcess("git", ["status", "--porcelain"], {
      cwd: cwd || process.cwd(),
      maxOutputBytes: DEFAULTS.maxOutputBytes,
    });
    const files = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3));
    return files;
  } catch (err) {
    return [];
  }
}

module.exports = {
  ensureGitRepo,
  getCurrentBranch,
  gitSwitchBranch,
  ensureGitWorktree,
  gitCommitIfNeeded,
  getGitModifiedFiles,
};

