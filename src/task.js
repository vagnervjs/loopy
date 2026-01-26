const yaml = require("js-yaml");

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

function getTaskLine(text) {
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

module.exports = {
  parseTask,
  getTaskLine,
};
