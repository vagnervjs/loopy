const fs = require("fs/promises");
const path = require("path");

const { appendActivity } = require("../activity");
const { prettyPath } = require("../config");
const { readText } = require("../fs");
const { parseTask } = require("../task");

const ARCHIVE_DIRNAME = "archive";

function stripLoopyPrefix(branch) {
  const raw = String(branch || "").trim();
  if (!raw) return "";
  if (raw.startsWith("loopy/")) return raw.slice("loopy/".length);
  if (raw.startsWith("loopy-")) return raw.slice("loopy-".length);
  if (raw.startsWith("loopy_")) return raw.slice("loopy_".length);
  return raw;
}

function archiveLoopFolderName(branch) {
  const base = stripLoopyPrefix(branch) || "completed-loop";
  const sanitized = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return sanitized || "completed-loop";
}

function isPathInside(baseDir, targetPath) {
  if (!baseDir || !targetPath) return false;
  const rel = path.relative(baseDir, targetPath);
  if (!rel) return true;
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function movePath(sourcePath, destinationPath) {
  try {
    await fs.rm(destinationPath, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }

  try {
    await fs.rename(sourcePath, destinationPath);
    return true;
  } catch (err) {
    if (err && err.code === "EXDEV") {
      const stat = await fs.stat(sourcePath);
      if (stat.isDirectory()) {
        await fs.mkdir(destinationPath, { recursive: true });
        await fs.cp(sourcePath, destinationPath, { recursive: true });
        await fs.rm(sourcePath, { recursive: true, force: true });
      } else {
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.copyFile(sourcePath, destinationPath);
        await fs.unlink(sourcePath);
      }
      return true;
    }
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function archiveCompletedLoop(config) {
  const taskPath = config.taskFile;
  if (!taskPath) return { archived: false, reason: "missing-path" };

  const taskText = await readText(taskPath);
  if (!taskText) return { archived: false, reason: "missing-plan" };

  let parsed = null;
  try {
    parsed = parseTask(taskText);
  } catch (_) {
    return { archived: false, reason: "parse-failed" };
  }
  if (!parsed.allChecked) return { archived: false, reason: "incomplete" };

  const fm = parsed.frontMatter || {};
  const fmGit = fm.git && typeof fm.git === "object" ? fm.git : {};
  const branch =
    String(config.gitBranch || "").trim() ||
    String(fm.git_branch || fm.gitBranch || "").trim() ||
    String(fmGit.branch || fmGit.git_branch || fmGit.gitBranch || "").trim();

  const baseDir = config.loopyDir || path.dirname(taskPath);
  const archiveRoot = path.join(baseDir, ARCHIVE_DIRNAME);
  const archiveDir = path.join(archiveRoot, archiveLoopFolderName(branch));
  await fs.mkdir(archiveDir, { recursive: true });

  const prettyArchive = prettyPath(config.cwd, archiveDir);
  await appendActivity(config.activityLog, [`Loop archived: ${prettyArchive}`]);

  const entries = await fs.readdir(baseDir);
  for (const entry of entries) {
    if (entry === ARCHIVE_DIRNAME) continue;
    const sourcePath = path.join(baseDir, entry);
    const destinationPath = path.join(archiveDir, entry);
    await movePath(sourcePath, destinationPath);
  }

  if (!isPathInside(baseDir, taskPath)) {
    const destinationPath = path.join(archiveDir, path.basename(taskPath));
    await movePath(taskPath, destinationPath);
  }

  return { archived: true, archiveDir };
}

module.exports = {
  archiveCompletedLoop,
};
