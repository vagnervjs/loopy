const { printBlankLine, printStep } = require("../steps");

function normalizeChecklistItems(items) {
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const item of items) {
    if (!item) continue;
    const text = String(item.text || "").trim();
    if (!text) continue;
    normalized.push({ checked: Boolean(item.checked), text });
  }
  return normalized;
}

function collectPlanSections(parsedTask) {
  const phases = (parsedTask && parsedTask.phases) || [];
  if (phases.length) {
    return phases.map((phase) => {
      const section = parsedTask.phaseSections && parsedTask.phaseSections[phase.id];
      return {
        scope: "phase",
        id: phase.id,
        title: String(phase.title || phase.id || "").trim(),
        items: normalizeChecklistItems(section && section.checklist),
      };
    });
  }
  return [
    {
      scope: "plan",
      id: "plan",
      title: "Plan",
      items: normalizeChecklistItems(parsedTask && parsedTask.checklist),
    },
  ];
}

function formatChecklistItem(item) {
  return `[${item.checked ? "x" : " "}] ${item.text}`;
}

function formatSectionLabel(section) {
  const title = String(section.title || "").trim();
  const id = String(section.id || "").trim();
  if (title && id && title !== id) return `${title} (${id})`;
  return title || id || "phase";
}

function formatPlanOverviewLines(parsedTask, options = {}) {
  const sections = collectPlanSections(parsedTask);
  if (!sections.length) return [];
  const verbose = Boolean(options.verbose);
  const totals = countChecklist(sections.flatMap((section) => section.items));
  const hasPhases = sections.some((section) => section.scope === "phase");
  const totalLabel = `${totals.total} task${totals.total === 1 ? "" : "s"}`;

  if (verbose) {
    const lines = [
      {
        message: hasPhases ? `Plan details (${sections.length} phases, ${totalLabel})` : `Plan details (${totalLabel})`,
        kind: "plan",
      },
    ];
    let phaseIndex = 0;
    for (const section of sections) {
      phaseIndex += 1;
      if (section.scope === "phase") {
        lines.push({
          message: `#${phaseIndex} ${formatSectionLabel(section)}`,
          kind: "plan-item",
          indent: 2,
        });
        if (!section.items.length) {
          lines.push({ message: "(no tasks)", kind: "plan-item", indent: 4 });
          continue;
        }
        let taskIndex = 0;
        for (const item of section.items) {
          taskIndex += 1;
          lines.push({
            message: `#${phaseIndex}.${taskIndex} ${formatChecklistItem(item)}`,
            kind: "plan-item",
            indent: 4,
          });
        }
        lines.push({ blank: true });
        continue;
      }
      if (!section.items.length) {
        lines.push({ message: "(no tasks)", kind: "plan-item", indent: 2 });
        continue;
      }
      let taskIndex = 0;
      for (const item of section.items) {
        taskIndex += 1;
        lines.push({ message: `#${taskIndex} ${formatChecklistItem(item)}`, kind: "plan-item", indent: 2 });
      }
    }
    return lines;
  }

  const header = hasPhases
    ? `Plan ${sections.length} phase${sections.length === 1 ? "" : "s"}, ${totalLabel}`
    : `Plan ${totalLabel}`;
  const lines = [{ message: header, kind: "plan" }];
  if (hasPhases) {
    for (const section of sections) {
      lines.push({
        message: `${formatSectionLabel(section)} (${section.items.length})`,
        kind: "plan-item",
        indent: 2,
      });
    }
  }
  return lines;
}

function countCheckedByText(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (!item || !item.checked) continue;
    const text = String(item.text || "").trim();
    if (!text) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return counts;
}

function diffNewlyChecked(beforeItems, afterItems) {
  const before = countCheckedByText(beforeItems);
  const after = countCheckedByText(afterItems);
  const newly = [];
  for (const [text, afterCount] of after.entries()) {
    const beforeCount = before.get(text) || 0;
    const diff = afterCount - beforeCount;
    if (diff > 0) {
      for (let i = 0; i < diff; i += 1) {
        newly.push(text);
      }
    }
  }
  return newly;
}

function findNewlyCompletedTasks(parsedBefore, parsedAfter) {
  const beforeSections = collectPlanSections(parsedBefore);
  const afterSections = collectPlanSections(parsedAfter);
  const beforeByKey = new Map();
  for (const section of beforeSections) {
    const key = section.scope === "phase" ? `phase:${section.id}` : "plan";
    beforeByKey.set(key, section.items);
  }

  const results = [];
  for (const section of afterSections) {
    const key = section.scope === "phase" ? `phase:${section.id}` : "plan";
    const beforeItems = beforeByKey.get(key) || [];
    const newly = diffNewlyChecked(beforeItems, section.items);
    if (!newly.length) continue;
    results.push({ ...section, items: newly });
  }
  return results;
}

function formatCompletedTaskLines(completedSections) {
  if (!completedSections || !completedSections.length) return [];
  const lines = [{ message: "Tasks completed", kind: "tasks" }];
  for (const section of completedSections) {
    if (section.scope === "phase") {
      lines.push({ message: formatSectionLabel(section), kind: "tasks", indent: 2 });
      for (const text of section.items) {
        lines.push({ message: `[x] ${text}`, kind: "tasks", indent: 4 });
      }
      continue;
    }
    for (const text of section.items) {
      lines.push({ message: `[x] ${text}`, kind: "tasks", indent: 2 });
    }
  }
  return lines;
}

function countChecklist(items) {
  let total = 0;
  let checked = 0;
  for (const item of items || []) {
    total += 1;
    if (item.checked) checked += 1;
  }
  return { total, checked };
}

function summarizePlanProgress(parsedTask, currentPhaseId) {
  const sections = collectPlanSections(parsedTask);
  const totals = countChecklist(sections.flatMap((section) => section.items));
  let phaseSummary = null;
  if (currentPhaseId) {
    const phase = sections.find((section) => section.scope === "phase" && section.id === currentPhaseId);
    if (phase) {
      phaseSummary = { id: phase.id, ...countChecklist(phase.items) };
    }
  }
  return { ...totals, phase: phaseSummary };
}

function formatProgressLine(summary) {
  if (!summary || !summary.total) return { message: "Tasks progress unavailable", kind: "tasks" };
  let line = `Tasks ${summary.checked}/${summary.total} complete`;
  if (summary.phase && summary.phase.total) {
    line += `; phase ${summary.phase.id}: ${summary.phase.checked}/${summary.phase.total}`;
  }
  return { message: line, kind: "tasks" };
}

function printStepLines(lines, options) {
  if (!Array.isArray(lines)) return;
  for (const line of lines) {
    if (!line) continue;
    if (typeof line === "object" && line.blank) {
      printBlankLine();
      continue;
    }
    if (typeof line === "string") {
      if (!line.trim()) continue;
      printStep(line, options);
      continue;
    }
    if (typeof line === "object") {
      const { message, text, ...lineOptions } = line;
      const msg = message != null ? message : text;
      if (!String(msg || "").trim()) continue;
      printStep(msg, { ...options, ...lineOptions });
    }
  }
}

module.exports = {
  collectPlanSections,
  findNewlyCompletedTasks,
  formatCompletedTaskLines,
  formatPlanOverviewLines,
  formatProgressLine,
  printStepLines,
  summarizePlanProgress,
};
