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

function normalizeGitPath(value) {
  if (value === undefined || value === null) return "";
  let normalized = String(value).trim();
  if (!normalized) return "";
  normalized = normalized.replace(/\\/g, "/");
  normalized = normalized.replace(/^\.\/+/, "");
  normalized = normalized.replace(/\/+/g, "/");
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function parsePorcelainPath(line) {
  const raw = String(line || "").slice(3).trim();
  if (!raw) return "";
  const arrowIndex = raw.lastIndexOf(" -> ");
  const target = arrowIndex === -1 ? raw : raw.slice(arrowIndex + 4);
  return normalizeGitPath(target);
}

function isPathInsideDir(filePath, dirPath) {
  if (!filePath || !dirPath) return false;
  if (filePath === dirPath) return true;
  return filePath.startsWith(`${dirPath}/`);
}

function resolveExcludedArtifactDirs(config) {
  const cwd = config && config.cwd ? String(config.cwd) : process.cwd();
  const configured = config && config.loopyDir ? String(config.loopyDir) : "";
  const dirs = new Set([".loopy"]);

  const addCandidate = (candidate) => {
    const normalized = normalizeGitPath(candidate);
    if (!normalized || normalized === ".") return;
    if (normalized.startsWith("../")) return;
    dirs.add(normalized);
  };

  if (configured) {
    if (path.isAbsolute(configured)) {
      addCandidate(path.relative(cwd, configured));
    } else {
      addCandidate(configured);
      addCandidate(path.relative(cwd, path.resolve(cwd, configured)));
    }
  }

  return Array.from(dirs);
}

/**
 * Check whether a file path is plausibly related to the task description.
 * Uses keyword overlap: extracts significant tokens from the task text and
 * checks if any appear in the file path (basename, directory, or extension-
 * stripped name).
 */
function isFileRelatedToTask(filePath, taskSummary) {
  if (!filePath || !taskSummary) return true; // no info → assume related
  const normalized = normalizeGitPath(filePath).toLowerCase();
  if (!normalized) return true;
  const basename = path.posix.basename(normalized);
  const withoutExt = basename.replace(/\.[^.]+$/, "");

  // Extract keywords from task summary (words >= 3 chars, excluding stop words)
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "have",
    "has", "was", "are", "were", "been", "being", "will", "would", "could",
    "should", "may", "can", "not", "but", "all", "any", "each", "every",
    "add", "set", "get", "run", "use", "new", "old", "update", "change",
    "make", "fix", "test", "file", "files", "task", "default",
  ]);
  const taskWords = String(taskSummary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  // Need at least 2 meaningful keywords to make a relatedness determination.
  // With fewer than 2, the task description is too vague to filter on.
  if (taskWords.length < 2) return true;

  for (const word of taskWords) {
    if (normalized.includes(word)) return true;
    if (basename.includes(word)) return true;
    if (withoutExt.includes(word)) return true;
  }
  return false;
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
  const excludedArtifactDirs = resolveExcludedArtifactDirs(config);
  const candidateFiles = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => parsePorcelainPath(line))
    .filter((file) => {
      if (!file) return false;
      if (file === "PROMPT.md") return false;
      if (excludedArtifactDirs.some((dirPath) => isPathInsideDir(file, dirPath))) return false;
      return true;
    });

  if (!candidateFiles.length) return { committed: false, reason: "no-changes" };

  // Partition files into task-related and unrelated
  const relatedFiles = candidateFiles.filter((f) => isFileRelatedToTask(f, taskSummary));
  const unrelatedFiles = candidateFiles.filter((f) => !isFileRelatedToTask(f, taskSummary));

  // If no files are related to the task, skip the commit entirely
  if (relatedFiles.length === 0 && unrelatedFiles.length > 0) {
    return {
      committed: false,
      reason: "unrelated-changes",
      filesChanged: candidateFiles,
      warning: "staged changes do not appear related to current task",
    };
  }

  // Stage only related files (selective staging) when there's a mix,
  // or stage everything if all are related.
  if (unrelatedFiles.length === 0) {
    // All files are related — stage broadly
    const addRes = await git(["add", "-A", "--", "."], { cwd: config.cwd });
    if (addRes.code !== 0) {
      const msg = (addRes.stderr || addRes.stdout || "").trim();
      throw new Error(msg || "Failed to stage changes (git add -A).");
    }
  } else {
    // Mixed: stage only related files
    for (const file of relatedFiles) {
      const addRes = await git(["add", "--", file], { cwd: config.cwd });
      if (addRes.code !== 0) {
        const msg = (addRes.stderr || addRes.stdout || "").trim();
        throw new Error(msg || `Failed to stage file: ${file}`);
      }
    }
  }

  // Unstage Loopy artifact paths
  for (const dirPath of excludedArtifactDirs) {
    const resetRes = await git(["reset", "-q", "--", dirPath], { cwd: config.cwd });
    if (resetRes.code !== 0) {
      const msg = (resetRes.stderr || resetRes.stdout || "").trim();
      if (/did not match any file/i.test(msg)) continue;
      throw new Error(msg || `Failed to unstage excluded path: ${dirPath}`);
    }
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
  return { committed: true, hash, message, filesChanged: relatedFiles };
}

async function getMergeBase(cwd, baseBranch) {
  const branch = baseBranch || "main";
  try {
    const res = await runProcess("git", ["merge-base", "HEAD", branch], {
      cwd: cwd || process.cwd(),
      maxOutputBytes: DEFAULTS.maxOutputBytes,
    });
    if (res.code === 0) {
      const sha = (res.stdout || "").trim();
      return sha || "";
    }
    // Try "master" as fallback if "main" was the default
    if (!baseBranch || branch === "main") {
      const fallback = await runProcess("git", ["merge-base", "HEAD", "master"], {
        cwd: cwd || process.cwd(),
        maxOutputBytes: DEFAULTS.maxOutputBytes,
      });
      if (fallback.code === 0) {
        return (fallback.stdout || "").trim();
      }
    }
    return "";
  } catch (err) {
    return "";
  }
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
      .map((line) => parsePorcelainPath(line))
      .filter(Boolean);
    return files;
  } catch (err) {
    return [];
  }
}

module.exports = {
  ensureGitRepo,
  getCurrentBranch,
  getMergeBase,
  gitSwitchBranch,
  ensureGitWorktree,
  normalizeGitPath,
  isPathInsideDir,
  isFileRelatedToTask,
  resolveExcludedArtifactDirs,
  gitCommitIfNeeded,
  getGitModifiedFiles,
};
