const path = require("path");

const { readText, writeText } = require("./fs");
const { runShellCommand } = require("./shell");
const { DEFAULTS } = require("./config");

/**
 * Extract a normalized set of failure signatures from test output.
 * Returns a sorted, deduplicated array of short strings that identify
 * individual test failures (test names or error patterns).
 */
function extractFailureSignatures(testOutput) {
  if (!testOutput) return [];

  const signatures = new Set();
  const lines = String(testOutput).split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Jest / Vitest style: "FAIL path/to/file.test.js"
    const failFileMatch = trimmed.match(/^FAIL\s+(.+)/);
    if (failFileMatch) {
      signatures.add(`FAIL:${failFileMatch[1].trim()}`);
      continue;
    }

    // Jest / Vitest style: "✕ test name" or "× test name" or "✗ test name"
    const failTestMatch = trimmed.match(/^[✕×✗]\s+(.+)/);
    if (failTestMatch) {
      signatures.add(`TEST:${failTestMatch[1].trim()}`);
      continue;
    }

    // Jest style: "● Suite > test name"
    const jestSuiteMatch = trimmed.match(/^●\s+(.+)/);
    if (jestSuiteMatch) {
      signatures.add(`TEST:${jestSuiteMatch[1].trim()}`);
      continue;
    }

    // Node.js test runner: "✖ test name" or "not ok N - test name"
    const nodeTestFail = trimmed.match(/^✖\s+(.+)/) || trimmed.match(/^not ok\s+\d+\s+-?\s*(.+)/);
    if (nodeTestFail) {
      signatures.add(`TEST:${nodeTestFail[1].trim()}`);
      continue;
    }

    // Generic error pattern: "Error: message" or "TypeError: message"
    const errorMatch = trimmed.match(/^(\w*Error):\s+(.+)/);
    if (errorMatch) {
      // Normalize by taking just the error type and first meaningful portion
      const errorType = errorMatch[1];
      const message = errorMatch[2].trim().slice(0, 120);
      signatures.add(`ERR:${errorType}:${message}`);
      continue;
    }

    // Mocha / TAP style: "N failing"
    const failingMatch = trimmed.match(/^(\d+)\s+failing\b/);
    if (failingMatch) {
      // Don't add the count itself — it changes
      continue;
    }
  }

  return Array.from(signatures).sort();
}

/**
 * Compare two sets of failure signatures to determine the relationship.
 *
 * Returns:
 *   - status: "identical" | "subset" | "improved" | "new_failures"
 *   - newFailures: array of signatures in current but not in baseline
 *   - resolvedFailures: array of signatures in baseline but not in current
 */
function diffFailures(baselineSignatures, currentSignatures) {
  const baseSet = new Set(baselineSignatures);
  const currSet = new Set(currentSignatures);

  const newFailures = currentSignatures.filter((s) => !baseSet.has(s));
  const resolvedFailures = baselineSignatures.filter((s) => !currSet.has(s));

  if (newFailures.length === 0 && resolvedFailures.length === 0) {
    return { status: "identical", newFailures: [], resolvedFailures: [] };
  }
  if (newFailures.length === 0 && resolvedFailures.length > 0) {
    return { status: "improved", newFailures: [], resolvedFailures };
  }
  if (newFailures.length > 0 && resolvedFailures.length === 0 && currentSignatures.length <= baselineSignatures.length) {
    // Current is a subset of baseline — should not happen if newFailures > 0.
    return { status: "new_failures", newFailures, resolvedFailures };
  }
  if (newFailures.length === 0) {
    // Current failures are a subset of baseline
    return { status: "subset", newFailures: [], resolvedFailures };
  }
  return { status: "new_failures", newFailures, resolvedFailures };
}

/**
 * Check whether the files changed by the agent overlap with files/modules
 * mentioned in the test error output. Returns true if there's plausible
 * relatedness (agent should attempt a fix), false otherwise.
 */
function checkRelatedness(changedFiles, testOutput) {
  if (!changedFiles || !changedFiles.length || !testOutput) return false;

  const output = String(testOutput);
  for (const file of changedFiles) {
    const normalized = String(file || "").trim();
    if (!normalized) continue;

    // Check the full path
    if (output.includes(normalized)) return true;

    // Check just the basename
    const basename = path.posix.basename(normalized);
    if (basename && output.includes(basename)) return true;

    // Check the module/directory name (e.g., "jest.config" from "jest.config.js")
    const withoutExt = basename.replace(/\.[^.]+$/, "");
    if (withoutExt && withoutExt.length > 3 && output.includes(withoutExt)) return true;
  }

  return false;
}

/**
 * Load a cached baseline test result from state.
 * Returns null if no cached result, or if cache is invalid/stale.
 */
function loadCachedBaseline(state, mergeBaseSha, testCommand) {
  const cached = state && state.baselineTestResult;
  if (!cached) return null;
  if (cached.commitSha !== mergeBaseSha) return null;
  if (cached.testCommand !== testCommand) return null;
  return cached;
}

/**
 * Run the test command at the merge-base commit to establish baseline.
 * Uses `git stash`, checks out merge-base, runs tests, then restores.
 *
 * Returns { exitCode, failureSignature, output }
 */
async function runBaselineTest(config, mergeBaseSha, testCommand, { stopSignal } = {}) {
  const cwd = config.cwd;

  // Save current state
  const stashResult = await runShellCommand("git stash --include-untracked", "", DEFAULTS.maxOutputBytes, {
    cwd,
    noColor: true,
    stopSignal,
  });
  if (stashResult.aborted) return { aborted: true };

  const didStash = !/(No local changes|Nothing to stash)/i.test(stashResult.stdout + stashResult.stderr);

  try {
    // Checkout merge-base
    const checkoutResult = await runShellCommand(
      `git checkout ${mergeBaseSha} --quiet`,
      "",
      DEFAULTS.maxOutputBytes,
      { cwd, noColor: true, stopSignal }
    );
    if (checkoutResult.aborted) return { aborted: true };
    if (checkoutResult.code !== 0) {
      return { exitCode: -1, failureSignature: [], output: "Failed to checkout merge-base", error: true };
    }

    // Run the test command at baseline
    const testResult = await runShellCommand(testCommand, "", DEFAULTS.maxOutputBytes, {
      cwd,
      noColor: true,
      stopSignal,
    });
    if (testResult.aborted) return { aborted: true };

    const output = `${testResult.stdout}\n${testResult.stderr}`;
    const failureSignature = testResult.code !== 0 ? extractFailureSignatures(output) : [];

    return {
      exitCode: testResult.code,
      failureSignature,
      output,
    };
  } finally {
    // Restore: go back to original branch
    await runShellCommand("git checkout -", "", DEFAULTS.maxOutputBytes, {
      cwd,
      noColor: true,
    });

    // Pop stash if we stashed
    if (didStash) {
      await runShellCommand("git stash pop", "", DEFAULTS.maxOutputBytes, {
        cwd,
        noColor: true,
      });
    }
  }
}

/**
 * Build a baseline test result object suitable for caching in state.json.
 */
function buildBaselineResult(mergeBaseSha, testCommand, exitCode, failureSignature) {
  return {
    commitSha: mergeBaseSha,
    testCommand,
    exitCode,
    failureSignature: failureSignature || [],
    cachedAt: new Date().toISOString(),
  };
}

/**
 * Main entry point: evaluate test failures using tiered recovery.
 *
 * Tier 1: If failures are plausibly related to agent's changes, allow fix.
 * Tier 2: Compare against baseline to determine if failures are pre-existing.
 *
 * Parameters:
 *   - config: loopy config object
 *   - state: current state object
 *   - testOutput: combined test stdout+stderr
 *   - testExitCode: exit code from test command
 *   - testCommand: the test command that was run
 *   - changedFiles: array of files modified by the agent
 *   - options: { stopSignal, getMergeBase }
 *
 * Returns:
 *   - action: "pass" | "fail" | "fix_attempt"
 *   - reason: human-readable explanation
 *   - newFailures: array of new failure signatures (if any)
 *   - baselineResult: baseline result object to cache (if computed)
 *   - stateUpdates: partial state object to merge
 */
async function evaluateTestFailure(config, state, {
  testOutput,
  testExitCode,
  testCommand,
  changedFiles,
  stopSignal,
  getMergeBase,
} = {}) {
  const fixBudget = Number.isFinite(config.fixBudget) ? config.fixBudget : 1;
  const fixAttempts = (state && state.baselineFixAttempts) || 0;

  const currentSignatures = extractFailureSignatures(testOutput);

  // --- Tier 1: Relatedness check ---
  const isRelated = checkRelatedness(changedFiles, testOutput);

  if (isRelated && fixAttempts < fixBudget) {
    return {
      action: "fix_attempt",
      reason: "test failures appear related to changed files; fix attempt allowed",
      newFailures: currentSignatures,
      baselineResult: null,
      stateUpdates: { baselineFixAttempts: fixAttempts + 1 },
    };
  }

  // --- Tier 2: Baseline comparison ---
  let mergeBaseSha = "";
  if (typeof getMergeBase === "function") {
    try {
      mergeBaseSha = await getMergeBase();
    } catch (_) {
      // Can't determine merge-base; treat as genuine failure
    }
  }

  if (!mergeBaseSha) {
    return {
      action: "fail",
      reason: "unable to determine merge-base for baseline comparison",
      newFailures: currentSignatures,
      baselineResult: null,
      stateUpdates: { baselineFixAttempts: fixAttempts + 1 },
    };
  }

  // Check cache first
  let baseline = loadCachedBaseline(state, mergeBaseSha, testCommand);

  if (!baseline) {
    // Run baseline test
    const baselineRun = await runBaselineTest(config, mergeBaseSha, testCommand, { stopSignal });
    if (baselineRun.aborted) {
      return { action: "fail", reason: "baseline test run aborted", aborted: true };
    }
    if (baselineRun.error) {
      return {
        action: "fail",
        reason: "failed to run baseline test: " + (baselineRun.output || "unknown error"),
        newFailures: currentSignatures,
        baselineResult: null,
        stateUpdates: {},
      };
    }

    baseline = buildBaselineResult(mergeBaseSha, testCommand, baselineRun.exitCode, baselineRun.failureSignature);
  }

  const diff = diffFailures(baseline.failureSignature, currentSignatures);

  if (diff.status === "identical" || diff.status === "subset") {
    return {
      action: "pass",
      reason: "pre-existing failures match baseline, treating as pass",
      newFailures: [],
      baselineResult: baseline,
      stateUpdates: { baselineFixAttempts: 0 },
    };
  }

  if (diff.status === "improved") {
    return {
      action: "pass",
      reason: "fewer failures than baseline (agent improved things)",
      newFailures: [],
      baselineResult: baseline,
      stateUpdates: { baselineFixAttempts: 0 },
    };
  }

  // new_failures: there are failures not present in baseline
  // Give a fix attempt if budget allows and scoped to new failures only
  if (fixAttempts < fixBudget) {
    return {
      action: "fix_attempt",
      reason: `${diff.newFailures.length} new failure(s) not in baseline; fix attempt allowed`,
      newFailures: diff.newFailures,
      baselineResult: baseline,
      stateUpdates: { baselineFixAttempts: fixAttempts + 1 },
    };
  }

  return {
    action: "fail",
    reason: `${diff.newFailures.length} new failure(s) not in baseline, fix budget exhausted`,
    newFailures: diff.newFailures,
    baselineResult: baseline,
    stateUpdates: { baselineFixAttempts: fixAttempts + 1 },
  };
}

module.exports = {
  extractFailureSignatures,
  diffFailures,
  checkRelatedness,
  loadCachedBaseline,
  runBaselineTest,
  buildBaselineResult,
  evaluateTestFailure,
};
