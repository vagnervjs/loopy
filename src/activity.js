const fs = require("fs/promises");
const path = require("path");

async function appendActivity(logPath, lines) {
  const payload = lines.map((line) => `[${new Date().toISOString()}] ${line}`).join("\n") + "\n";
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, payload, "utf8");
}

module.exports = {
  appendActivity,
};

