const path = require("path");
const yaml = require("js-yaml");

const { appendActivity } = require("../activity");
const { DEFAULTS, prettyPath } = require("../config");
const { confirm, promptLine } = require("../confirm");
const { readText, writeText } = require("../fs");
const { ensureGuardrails, formatPrompt } = require("../prompt");
const { printStep } = require("../steps");
const { getCurrentPhaseSection, getCurrentTask, parseTask, resolvePrdRefsForCurrentTask } = require("../task");
const { redact, truncate } = require("../text");
const { fallbackPhasesFromSeed, proposePhasesWithAgent, renderTaskMarkdown } = require("../auto-phase");
const { pickCurrentPhaseId } = require("./phases");
const { loadTaskSeed } = require("./seed");

const PLAN_OUTPUT_FILE = "last_plan_output.txt";

async function recordPlanGenerationFailure(config, { output, error, seedSource }) {
  const logPath = path.join(config.loopyDir, PLAN_OUTPUT_FILE);
  const header = [
    "# Loopy Plan Generation Output",
    "",
    `Timestamp: ${new Date().toISOString()}`,
    `Error: ${error || "unknown"}`,
    `Seed source: ${seedSource || "unknown"}`,
    "",
  ].join("\n");
  const payload = header + (output ? truncate(String(output), DEFAULTS.maxOutputBytes) : "(no output)") + "\n";
  await writeText(logPath, payload);
  await appendActivity(config.activityLog, [
    `plan generation failed: ${error || "unknown"} (see ${prettyPath(config.cwd, logPath)})`,
  ]);
}

async function ensureTaskBeforeLoop(config, loadedSeed, { stopSignal } = {}) {
  const cwd = config.cwd;
  const taskPath = config.taskFile;
  const shouldStop = () => Boolean(stopSignal && stopSignal.stopRequested);
  const phaseAgentLabel = config.agentCommand ? ` with ${redact(config.agentCommand)}` : "";
  const logPhasePlan = () => {
    printStep(`Generating phase plan${phaseAgentLabel}`, { kind: "plan" });
  };

  let existing = await readText(taskPath);
  if (shouldStop()) {
    return { taskText: existing || "", rewritten: false, aborted: true };
  }
  if (!existing) {
    const loaded = loadedSeed || (await loadTaskSeed(config));
    let seed = loaded.seed;
    const seedSource = loaded.source || "interactive";
    if (!seed) {
      seed = await promptLine(`Enter a short plan description for ${prettyPath(cwd, taskPath)}: `);
    }
    if (!seed) {
      throw new Error(
        `Missing ${prettyPath(cwd, taskPath)} and no seed prompt provided (use --prompt, or run in a TTY).`
      );
    }

    let testCommand = config.testCommand;
    if (!String(testCommand || "").trim()) {
      if (!process.stdin.isTTY) {
        throw new Error("Missing test command for plan (set test_command in plan front matter or config).");
      }
      testCommand = await promptLine("Enter test command for this plan (required): ");
    }
    testCommand = String(testCommand || "").trim();
    if (!testCommand) {
      throw new Error("Missing test command for plan (required).");
    }

    // If auto-phase is on, try to generate phases; otherwise create a minimal legacy task file.
    let nextText = "";
    if (config.autoPhase) {
      logPhasePlan();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed, { noColor: config.noColor, stopSignal });
      if (proposed.aborted || shouldStop()) {
        return { taskText: "", rewritten: false, aborted: true };
      }
      if (!proposed.ok) {
        await recordPlanGenerationFailure(config, {
          output: proposed.output,
          error: proposed.error,
          seedSource,
        });
      }
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : fallbackPhasesFromSeed(seed, { testCommand });
      if (!plan.phaseDefaults || typeof plan.phaseDefaults !== "object") {
        plan.phaseDefaults = {};
      }
      if (!String(plan.phaseDefaults.test_command || plan.phaseDefaults.testCommand || "").trim()) {
        plan.phaseDefaults.test_command = testCommand;
      }
      const fm = {
        agent_command: config.agentCommand || "",
        test_command: testCommand,
        max_iterations: config.maxIterations,
        max_minutes: config.maxMinutes,
        backoff_ms: config.backoffMs,
        rotate_bytes: config.rotateBytes,
        git: {
          branch: config.gitBranch || "",
          commit: Boolean(config.gitCommit),
          commit_message: config.gitCommitMessage || "",
        },
      };
      nextText = renderTaskMarkdown({
        frontMatter: fm,
        phaseDefaults: plan.phaseDefaults,
        phases: plan.phases,
        tasksByPhase: plan.tasksByPhase,
        includeSeedComment: true,
        seedText: seed,
      });
    } else {
      nextText = [
        "---",
        yaml.dump(
          {
            agent_command: config.agentCommand || "",
            test_command: testCommand,
            max_iterations: config.maxIterations,
            max_minutes: config.maxMinutes,
            backoff_ms: config.backoffMs,
            rotate_bytes: config.rotateBytes,
          },
          { lineWidth: 120 }
        ).trimEnd(),
        "---",
        "",
        "# Plan",
        "",
        `- [ ] ${seed}`,
        "",
      ].join("\n");
    }

    const ok = await confirm(`Write new ${prettyPath(cwd, taskPath)}?`, {
      confirm: config.confirm,
      defaultYes: true,
    });
    if (!ok) throw new Error(`Aborted: ${prettyPath(cwd, taskPath)} not created.`);
    await writeText(taskPath, nextText);
    return { taskText: nextText, rewritten: true };
  }

  // User-provided prompt explicitly requests an update (apply automatically).
  const loaded = loadedSeed || (await loadTaskSeed(config));
  if (loaded.seed) {
    const seed = loaded.seed;
    const parsed = parseTask(existing);
    const fm = parsed.frontMatter || {};
    let testCommand = config.testCommand || fm.test_command || fm.testCommand || "";
    if (!String(testCommand || "").trim()) {
      if (!process.stdin.isTTY) {
        throw new Error("Missing test command for plan update (set test_command in plan front matter or config).");
      }
      testCommand = await promptLine("Enter test command for this plan (required): ");
    }
    testCommand = String(testCommand || "").trim();
    if (!testCommand) {
      throw new Error("Missing test command for plan update (required).");
    }

    let nextText = existing;
    if (config.autoPhase) {
      logPhasePlan();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed, { noColor: config.noColor, stopSignal });
      if (proposed.aborted || shouldStop()) {
        return { taskText: existing, rewritten: false, aborted: true };
      }
      if (!proposed.ok) {
        await recordPlanGenerationFailure(config, {
          output: proposed.output,
          error: proposed.error,
          seedSource: loaded.source || "--prompt",
        });
      }
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : fallbackPhasesFromSeed(seed, { testCommand });
      if (!plan.phaseDefaults || typeof plan.phaseDefaults !== "object") {
        plan.phaseDefaults = {};
      }
      if (!String(plan.phaseDefaults.test_command || plan.phaseDefaults.testCommand || "").trim()) {
        plan.phaseDefaults.test_command = testCommand;
      }
      if (!String(fm.test_command || fm.testCommand || "").trim()) {
        fm.test_command = testCommand;
      }
      nextText = renderTaskMarkdown({
        frontMatter: fm,
        phaseDefaults: plan.phaseDefaults,
        phases: plan.phases,
        tasksByPhase: plan.tasksByPhase,
        includeSeedComment: true,
        seedText: seed,
      });
    } else {
      // Non-phased update: overwrite checklist with a single new item.
      nextText = [
        "---",
        yaml.dump(fm, { lineWidth: 120 }).trimEnd(),
        "---",
        "",
        "# Plan",
        "",
        `- [ ] ${seed}`,
        "",
      ].join("\n");
    }

    if (nextText !== existing) {
      const ok = await confirm(`Update ${prettyPath(cwd, taskPath)}?`, {
        confirm: config.confirm,
        defaultYes: true,
      });
      if (!ok) throw new Error(`Aborted: ${prettyPath(cwd, taskPath)} not updated.`);
      await writeText(taskPath, nextText);
      return { taskText: nextText, rewritten: true };
    }
    return { taskText: existing, rewritten: false };
  }

  // Auto-phase insertion (only when enabled and phases are absent).
  if (config.autoPhase) {
    const parsed = parseTask(existing);
    const hasPhases = Boolean(parsed.phases && parsed.phases.length);
    if (!hasPhases) {
      const seed = parsed.body && parsed.body.trim() ? parsed.body.trim() : existing.trim();
      logPhasePlan();
      const proposed = await proposePhasesWithAgent(config.agentCommand, seed, { noColor: config.noColor, stopSignal });
      if (proposed.aborted || shouldStop()) {
        return { taskText: existing, rewritten: false, aborted: true };
      }
      if (!proposed.ok) {
        await recordPlanGenerationFailure(config, {
          output: proposed.output,
          error: proposed.error,
          seedSource: "plan-doc",
        });
      }
      const plan = proposed.ok
        ? { phases: proposed.phases, phaseDefaults: proposed.phaseDefaults, tasksByPhase: proposed.tasksByPhase }
        : null;
      if (plan) {
        let testCommand = config.testCommand || parsed.frontMatter.test_command || parsed.frontMatter.testCommand || "";
        if (!String(testCommand || "").trim()) {
          if (!process.stdin.isTTY) {
            throw new Error("Missing test command for plan (set test_command in plan front matter or config).");
          }
          testCommand = await promptLine("Enter test command for this plan (required): ");
        }
        testCommand = String(testCommand || "").trim();
        if (!testCommand) {
          throw new Error("Missing test command for plan (required).");
        }
        if (!plan.phaseDefaults || typeof plan.phaseDefaults !== "object") {
          plan.phaseDefaults = {};
        }
        if (!String(plan.phaseDefaults.test_command || plan.phaseDefaults.testCommand || "").trim()) {
          plan.phaseDefaults.test_command = testCommand;
        }
        const nextText = renderTaskMarkdown({
          frontMatter: parsed.frontMatter || {},
          phaseDefaults: plan.phaseDefaults,
          phases: plan.phases,
          tasksByPhase: plan.tasksByPhase,
          includeSeedComment: true,
          seedText: seed,
        });
        if (nextText !== existing) {
          const ok = await confirm(`Apply auto-phase plan to ${prettyPath(cwd, taskPath)}?`, {
            confirm: config.confirm,
            defaultYes: false,
          });
          if (ok) {
            await writeText(taskPath, nextText);
            return { taskText: nextText, rewritten: true };
          }
        }
      }
    }
  }

  return { taskText: existing, rewritten: false };
}

async function confirmPlanReview(config, { prdGenerated } = {}) {
  if (!process.stdin.isTTY) return true;
  const planLabel = prettyPath(config.cwd, config.taskFile);
  const prdLabel = prdGenerated ? prettyPath(config.cwd, config.prdFile) : "";
  const question = prdGenerated
    ? `Review ${planLabel} and ${prdLabel} before continuing. Continue?`
    : `Review ${planLabel} before continuing. Continue?`;
  const ok = await confirm(question, { confirm: true, defaultYes: true });
  if (!ok) {
    throw new Error("Aborted: plan review not confirmed.");
  }
  return true;
}

async function writePromptPreview(config) {
  const taskText = await readText(config.taskFile);
  if (!taskText) {
    throw new Error(`Missing ${prettyPath(config.cwd, config.taskFile)}.`);
  }
  const parsedTask = parseTask(taskText);

  let guardrailsText = await readText(config.guardrailsFile);
  const ensuredGuardrails = ensureGuardrails(guardrailsText);
  if (ensuredGuardrails !== guardrailsText) {
    await writeText(config.guardrailsFile, ensuredGuardrails);
    guardrailsText = ensuredGuardrails;
  }

  const progressText = await readText(config.progressFile);
  const hintsTextRaw = await readText(config.hintsFile);
  const hintsText = truncate(hintsTextRaw, 8000);

  const currentPhaseId = pickCurrentPhaseId(parsedTask, {}, config, { phaseExplicit: false });
  const currentTaskObj = getCurrentTask(taskText, { phaseId: currentPhaseId });
  const currentTaskText = currentTaskObj ? currentTaskObj.text.trim() : null;
  const filteredPlan = currentPhaseId ? getCurrentPhaseSection(taskText, currentPhaseId) : taskText;
  const prdRefs = resolvePrdRefsForCurrentTask(parsedTask, currentPhaseId, currentTaskObj);

  const prompt = formatPrompt({
    iteration: 0,
    taskText,
    taskSeedText: config.taskSeedText || "",
    taskSeedSource: config.taskSeedSource || "",
    guardrailsText,
    progressText: progressText || "(no progress recorded yet)",
    lastOutput: "",
    rotationPending: false,
    currentPhase: currentPhaseId,
    taskFilePath: config.taskFile,
    hintsText,
    prdRefs,
    currentTask: currentTaskText,
    filteredPlan,
    promptTemplate: config.promptTemplateText || "",
  });

  await writeText(config.promptFile, prompt);
  printStep(`Prompt saved to ${prettyPath(config.cwd, config.promptFile)}`, { kind: "prompt" });
}

module.exports = {
  confirmPlanReview,
  ensureTaskBeforeLoop,
  recordPlanGenerationFailure,
  writePromptPreview,
};
