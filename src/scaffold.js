const fs = require("fs/promises");
const path = require("path");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function buildJudgeModuleText() {
  return [
    'const { spawn } = require("child_process");',
    'const fs = require("fs/promises");',
    'const path = require("path");',
    "",
    "const DEFAULT_TIMEOUT_MS = 60000;",
    "const MAX_OUTPUT_BYTES = 200000;",
    "",
    "function resolveAgentCommand(explicit) {",
    "  if (explicit) return explicit;",
    "  return (",
    "    process.env.LOOPY_AGENT_COMMAND ||",
    "    process.env.JUDGE_AGENT_COMMAND ||",
    "    process.env.AGENT_COMMAND ||",
    "    \"\"",
    "  );",
    "}",
    "",
    "function isImagePath(value) {",
    "  const ext = path.extname(String(value || \"\").toLowerCase());",
    "  return ext === \".png\" || ext === \".jpg\" || ext === \".jpeg\" || ext === \".webp\";",
    "}",
    "",
    "async function readArtifact(artifact) {",
    "  const raw = String(artifact || \"\");",
    "  if (!raw || raw.includes(\"\\n\")) return { kind: \"text\", value: raw };",
    "  try {",
    "    const stat = await fs.stat(raw);",
    "    if (stat && stat.isFile()) {",
    "      if (isImagePath(raw)) return { kind: \"image\", value: raw };",
    "      const text = await fs.readFile(raw, \"utf8\");",
    "      return { kind: \"file\", value: text, path: raw };",
    "    }",
    "  } catch (_) {",
    "  }",
    "  return { kind: \"text\", value: raw };",
    "}",
    "",
    "function buildPrompt({ criteria, artifact }) {",
    "  const lines = [",
    "    \"You are a strict reviewer.\",",
    "    \"Return PASS or FAIL on the first line.\",",
    "    \"If FAIL, include a short reason on subsequent lines.\",",
    "    \"\",",
    "    \"Criteria:\",",
    "    String(criteria || \"\").trim(),",
    "    \"\",",
    "  ];",
    "  if (artifact.kind === \"image\") {",
    "    lines.push(`Artifact image path: ${artifact.value}`);",
    "    lines.push(\"If you can inspect images, open the file and evaluate. Otherwise return FAIL and explain.\");",
    "  } else if (artifact.kind === \"file\") {",
    "    lines.push(`Artifact file path: ${artifact.path}`);",
    "    lines.push(\"Artifact contents:\");",
    "    lines.push(artifact.value || \"(empty)\");",
    "  } else {",
    "    lines.push(\"Artifact contents:\");",
    "    lines.push(artifact.value || \"(empty)\");",
    "  }",
    "  return lines.join(\"\\n\");",
    "}",
    "",
    "function parseResult(output) {",
    "  const text = String(output || \"\").trim();",
    "  if (!text) return { pass: false, feedback: \"empty judge response\" };",
    "  const lines = text.split(/\\r?\\n/);",
    "  const first = lines[0].trim().toUpperCase();",
    "  if (first.startsWith(\"PASS\")) return { pass: true };",
    "  if (first.startsWith(\"FAIL\")) {",
    "    const feedback = lines.slice(1).join(\"\\\\n\").trim();",
    "    return { pass: false, feedback: feedback || \"judge marked FAIL\" };",
    "  }",
    "  return { pass: false, feedback: \"judge response did not start with PASS or FAIL\" };",
    "}",
    "",
    "function runCommand(command, input, { timeoutMs } = {}) {",
    "  return new Promise((resolve, reject) => {",
    "    const child = spawn(command, { shell: true, stdio: [\"pipe\", \"pipe\", \"pipe\"] });",
    "    let stdout = \"\";",
    "    let stderr = \"\";",
    "    let timedOut = false;",
    "    const timeout = setTimeout(() => {",
    "      timedOut = true;",
    "      try { child.kill(\"SIGKILL\"); } catch (_) { }",
    "    }, timeoutMs || DEFAULT_TIMEOUT_MS);",
    "    child.stdout.on(\"data\", (chunk) => {",
    "      stdout += String(chunk || \"\");",
    "      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES);",
    "    });",
    "    child.stderr.on(\"data\", (chunk) => {",
    "      stderr += String(chunk || \"\");",
    "      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);",
    "    });",
    "    child.on(\"error\", (err) => {",
    "      clearTimeout(timeout);",
    "      reject(err);",
    "    });",
    "    child.on(\"close\", (code) => {",
    "      clearTimeout(timeout);",
    "      if (timedOut) {",
    "        reject(new Error(\"judge command timed out\"));",
    "        return;",
    "      }",
    "      resolve({ code, stdout, stderr });",
    "    });",
    "    try {",
    "      child.stdin.write(String(input || \"\"));",
    "      child.stdin.end();",
    "    } catch (_) {",
    "    }",
    "  });",
    "}",
    "",
    "async function createReview({ criteria, artifact, agentCommand, timeoutMs } = {}) {",
    "  const cmd = resolveAgentCommand(agentCommand);",
    "  if (!cmd) {",
    "    throw new Error(\"Missing agent command for judge (set LOOPY_AGENT_COMMAND).\");",
    "  }",
    "  const artifactData = await readArtifact(artifact);",
    "  const prompt = buildPrompt({ criteria, artifact: artifactData });",
    "  const result = await runCommand(cmd, prompt, { timeoutMs });",
    "  const output = result.stdout || result.stderr || \"\";",
    "  return parseResult(output);",
    "}",
    "",
    "module.exports = {",
    "  createReview,",
    "};",
    "",
  ].join("\n");
}

function buildJudgeTestText() {
  return [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    "",
    'const { createReview } = require("./llm-review");',
    "",
    "const agentCommand = process.env.LOOPY_AGENT_COMMAND || process.env.JUDGE_AGENT_COMMAND || process.env.AGENT_COMMAND;",
    "",
    "test(\"llm-review - text example\", { skip: !agentCommand }, async () => {",
    "  const result = await createReview({",
    "    criteria: \"The message is concise and friendly.\",",
    "    artifact: \"Thanks for the update. I will take a look and respond shortly.\",",
    "  });",
    "  assert.equal(typeof result.pass, \"boolean\");",
    "});",
    "",
    "const imagePath = process.env.JUDGE_IMAGE_PATH;",
    "test(\"llm-review - image path example\", { skip: !agentCommand || !imagePath }, async () => {",
    "  const result = await createReview({",
    "    criteria: \"The primary action is visually prominent and clear.\",",
    "    artifact: imagePath,",
    "  });",
    "  assert.equal(typeof result.pass, \"boolean\");",
    "});",
    "",
  ].join("\n");
}

async function scaffoldJudge({ cwd, force } = {}) {
  const root = cwd || process.cwd();
  const libDir = path.join(root, "src", "lib");
  const modulePath = path.join(libDir, "llm-review.js");
  const testPath = path.join(libDir, "llm-review.test.js");

  await fs.mkdir(libDir, { recursive: true });

  const created = [];
  const skipped = [];

  if (await pathExists(modulePath)) {
    if (!force) {
      skipped.push(modulePath);
    } else {
      await fs.writeFile(modulePath, buildJudgeModuleText(), "utf8");
      created.push(modulePath);
    }
  } else {
    await fs.writeFile(modulePath, buildJudgeModuleText(), "utf8");
    created.push(modulePath);
  }

  if (await pathExists(testPath)) {
    if (!force) {
      skipped.push(testPath);
    } else {
      await fs.writeFile(testPath, buildJudgeTestText(), "utf8");
      created.push(testPath);
    }
  } else {
    await fs.writeFile(testPath, buildJudgeTestText(), "utf8");
    created.push(testPath);
  }

  return { created, skipped, modulePath, testPath };
}

module.exports = {
  scaffoldJudge,
};
