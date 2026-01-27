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
  redact,
  truncate,
  normalizeTaskSeedText,
  renderTemplate,
};
