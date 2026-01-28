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

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function normalizeTaskSeedText(raw) {
  if (raw === undefined || raw === null) return "";
  let text = String(raw);
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Normalize line endings.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Trim only leading/trailing empty lines (preserve indentation and internal whitespace).
  const lines = text.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
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

module.exports = {
  formatLocalTimestamp,
  redact,
  truncate,
  normalizeTaskSeedText,
  renderTemplate,
};
