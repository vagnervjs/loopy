const path = require("path");
const nodeFs = require("fs");

const { readText } = require("../fs");

async function buildSpecsSummary(cwd, { limit = 20 } = {}) {
  const specsDir = path.join(cwd, "specs");
  let entries = [];
  try {
    entries = await nodeFs.promises.readdir(specsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
  const files = entries
    .filter((entry) => entry && entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .sort();

  if (!files.length) return "";
  const items = [];
  for (const filename of files.slice(0, limit)) {
    const filePath = path.join(specsDir, filename);
    let text = "";
    try {
      text = await readText(filePath);
    } catch (err) {
      text = "";
    }
    const titleMatch = String(text || "").match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : "";
    const label = title ? `${filename} — ${title}` : filename;
    items.push(`- ${label}`);
  }
  const body = items.join("\n");
  const suffix = files.length > limit ? `\n- …and ${files.length - limit} more` : "";
  return body + suffix;
}

module.exports = {
  buildSpecsSummary,
};
