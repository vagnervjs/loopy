const yaml = require("js-yaml");

function toSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeStopOn(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  return String(value).trim() ? [String(value).trim()] : [];
}

function parsePhases(frontMatter) {
  const fm = frontMatter || {};
  const phaseDefaults = fm.phase_defaults || fm.phaseDefaults || {};
  const raw = fm.phases;
  if (!Array.isArray(raw)) {
    return { phases: [], phaseDefaults: phaseDefaults || {} };
  }

  const phases = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const title = entry.trim();
      const id = toSlug(title) || title;
      phases.push({
        id,
        title: title || id,
        stopOn: normalizeStopOn(phaseDefaults.stop_on || phaseDefaults.stopOn),
        testCommand: phaseDefaults.test_command || phaseDefaults.testCommand || "",
      });
      continue;
    }

    if (entry && typeof entry === "object") {
      const idRaw = entry.id || entry.phase || entry.name || entry.key || "";
      const titleRaw = entry.title || entry.label || entry.name || entry.id || "";
      const id = toSlug(idRaw) || toSlug(titleRaw) || String(idRaw || titleRaw || "").trim();
      if (!id) continue;
      const stopOn =
        normalizeStopOn(entry.stop_on || entry.stopOn).length > 0
          ? normalizeStopOn(entry.stop_on || entry.stopOn)
          : normalizeStopOn(phaseDefaults.stop_on || phaseDefaults.stopOn);
      const testCommand =
        String(entry.test_command || entry.testCommand || "").trim() ||
        String(phaseDefaults.test_command || phaseDefaults.testCommand || "").trim();
      phases.push({
        id,
        title: String(titleRaw || id).trim() || id,
        stopOn,
        testCommand,
      });
    }
  }

  return { phases, phaseDefaults: phaseDefaults || {} };
}

function extractPhaseIdFromLine(line, phaseIdSet) {
  const raw = String(line || "");

  // HTML marker (preferred, unambiguous)
  // <!-- loopy:phase build -->
  // <!-- loopy:phase id=build -->
  const marker = raw.match(/<!--\s*loopy:phase(?:\s+id\s*=\s*|\s+)([a-zA-Z0-9._-]+)\s*-->/i);
  if (marker) {
    const id = toSlug(marker[1]) || marker[1];
    if (phaseIdSet.has(id)) return id;
  }

  // Heading forms:
  // ## Phase: build
  // ## build
  // ## Build (build)
  const heading = raw.match(/^#{2,6}\s+(.+?)\s*$/);
  if (!heading) return "";
  const text = heading[1].trim();
  const phasePrefix = text.match(/^phase\s*:\s*([a-zA-Z0-9._-]+)\b/i);
  if (phasePrefix) {
    const id = toSlug(phasePrefix[1]) || phasePrefix[1];
    if (phaseIdSet.has(id)) return id;
  }

  const paren = text.match(/\(([a-zA-Z0-9._-]+)\)\s*$/);
  if (paren) {
    const id = toSlug(paren[1]) || paren[1];
    if (phaseIdSet.has(id)) return id;
  }

  const slug = toSlug(text);
  if (slug && phaseIdSet.has(slug)) return slug;
  if (phaseIdSet.has(text)) return text;
  return "";
}

function parseTask(text) {
  const result = {
    frontMatter: {},
    body: text,
    checklist: [],
    allChecked: false,
    phases: [],
    phaseDefaults: {},
    phaseSections: {}, // id -> { checklist, allChecked, startLine, endLine }
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

  const { phases, phaseDefaults } = parsePhases(result.frontMatter);
  result.phases = phases;
  result.phaseDefaults = phaseDefaults;

  const checklist = parseCheckboxes(text).map((item) => {
    const entry = { checked: item.checked, text: item.text };
    if (item.skipped) entry.skipped = true;
    if (item.blocked) entry.blocked = true;
    return entry;
  });

  result.checklist = checklist;
  result.allChecked = checklist.length > 0 && checklist.every((item) => item.checked);

  // Phase section checklists (scoped)
  if (phases.length) {
    const phaseIdSet = new Set(phases.map((p) => p.id));
    const bodyLines = String(result.body || "").split(/\r?\n/);
    let currentPhase = "";
    let currentStart = -1;
    const sections = {};
    let inSeedComment = false;

    const closeSection = (endLineExclusive) => {
      if (!currentPhase) return;
      const start = currentStart >= 0 ? currentStart : 0;
      const end = Math.max(start, endLineExclusive);
      const slice = bodyLines.slice(start, end).join("\n");
      const items = parseCheckboxes(slice).map((item) => {
        const entry = { checked: item.checked, text: item.text };
        if (item.skipped) entry.skipped = true;
        if (item.blocked) entry.blocked = true;
        return entry;
      });
      sections[currentPhase] = {
        checklist: items,
        allChecked: items.length > 0 && items.every((it) => it.checked),
        startLine: start,
        endLine: end,
      };
    };

    for (let i = 0; i < bodyLines.length; i += 1) {
      const line = bodyLines[i];
      const raw = String(line || "");

      // Ignore multi-line seed blocks so PRD-style content can't affect phase parsing.
      if (inSeedComment) {
        if (raw.includes("-->")) inSeedComment = false;
        continue;
      }
      const seedStart = raw.match(/<!--\s*loopy:seed\b/i);
      if (seedStart) {
        if (!raw.includes("-->")) inSeedComment = true;
        continue;
      }

      const nextPhase = extractPhaseIdFromLine(line, phaseIdSet);
      if (nextPhase) {
        if (currentPhase) closeSection(i);
        currentPhase = nextPhase;
        currentStart = i + 1;
      }
    }
    if (currentPhase) closeSection(bodyLines.length);
    result.phaseSections = sections;
  }

  return result;
}

function getTaskLine(text, options = {}) {
  if (!text) return "task update";
  const parsed = parseTask(text);
  const phaseId = options && options.phaseId ? String(options.phaseId) : "";
  const phaseChecklist =
    phaseId && parsed.phaseSections && parsed.phaseSections[phaseId]
      ? parsed.phaseSections[phaseId].checklist
      : null;
  const list = phaseChecklist || parsed.checklist;
  const firstOpen = list.find((item) => !item.checked);
  if (firstOpen && firstOpen.text) return firstOpen.text.trim();
  const firstItem = list[0];
  if (firstItem && firstItem.text) return firstItem.text.trim();
  const bodyLines = (parsed.body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (bodyLines.length) return bodyLines[0];
  return "task update";
}

function getCurrentTask(text, options = {}) {
  if (!text) return null;
  const parsed = parseTask(text);
  const phaseId = options && options.phaseId ? String(options.phaseId) : "";
  const phaseChecklist =
    phaseId && parsed.phaseSections && parsed.phaseSections[phaseId]
      ? parsed.phaseSections[phaseId].checklist
      : null;
  const list = phaseChecklist || parsed.checklist;
  // Skip blocked [!] tasks when searching for the next open task
  const firstOpen = list.find((item) => !item.checked && !item.blocked);
  return firstOpen || null;
}

function getCurrentPhaseSection(text, phaseId) {
  if (!text || !phaseId) return text;
  const parsed = parseTask(text);
  if (!parsed.phaseSections || !parsed.phaseSections[phaseId]) return text;
  
  const bodyLines = String(parsed.body || "").split(/\r?\n/);
  const phaseSection = parsed.phaseSections[phaseId];
  
  // Find the phase header (it's usually just before startLine)
  let phaseHeaderLine = -1;
  for (let i = 0; i < phaseSection.startLine && i < bodyLines.length; i += 1) {
    const line = bodyLines[i];
    if (line.includes(`<!-- loopy:phase ${phaseId} -->`)) {
      // Found the marker, the header is likely the line before or at this position
      phaseHeaderLine = i - 1;
      if (phaseHeaderLine < 0 || !bodyLines[phaseHeaderLine].match(/^#{2,6}\s+/)) {
        phaseHeaderLine = i;
      }
      break;
    }
  }
  
  // If we didn't find the marker, look for a heading near startLine
  if (phaseHeaderLine === -1) {
    for (let i = Math.max(0, phaseSection.startLine - 3); i < phaseSection.startLine; i += 1) {
      if (bodyLines[i] && bodyLines[i].match(/^#{2,6}\s+/)) {
        phaseHeaderLine = i;
      }
    }
  }
  
  // Include everything from the beginning through the end of this phase
  const startIndex = phaseHeaderLine >= 0 ? phaseHeaderLine : phaseSection.startLine;
  const filteredBodyLines = ["# Plan", "", ...bodyLines.slice(startIndex, phaseSection.endLine)];
  const filteredBody = filteredBodyLines.join("\n");
  
  // Find where the body starts in the full text
  const headerEndIndex = text.indexOf(parsed.body);
  if (headerEndIndex === -1) return text;
  
  const header = text.slice(0, headerEndIndex);
  
  return header + filteredBody;
}

function parseCheckboxes(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const checkboxes = [];
  let inComment = false;
  
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      continue;
    }
    
    let effective = raw;
    const commentStart = raw.indexOf("<!--");
    if (commentStart >= 0) {
      const commentEnd = raw.indexOf("-->", commentStart + 4);
      if (commentEnd >= 0) {
        effective = raw.slice(0, commentStart);
      } else {
        effective = raw.slice(0, commentStart);
        inComment = true;
      }
    }
    
    const itemMatch = effective.match(/^-\s*\[( |x|X|~|-|!)\]\s+(.*)$/);
    if (itemMatch) {
      const marker = itemMatch[1];
      const isSkipped = marker === "~" || marker === "-";
      const isBlocked = marker === "!";
      const entry = {
        line: i + 1,
        checked: marker.toLowerCase() === "x" || isSkipped || isBlocked,
        text: itemMatch[2],
      };
      if (isSkipped) entry.skipped = true;
      if (isBlocked) entry.blocked = true;
      checkboxes.push(entry);
    }
  }
  
  return checkboxes;
}

function compareCheckboxDiffs(before, after) {
  const beforeMap = new Map();
  const beforeBoxes = parseCheckboxes(before);
  const afterBoxes = parseCheckboxes(after);
  
  for (const box of beforeBoxes) {
    beforeMap.set(box.text, box.checked);
  }
  
  const newlyChecked = [];
  for (const box of afterBoxes) {
    const wasPreviouslyUnchecked = beforeMap.has(box.text) && beforeMap.get(box.text) === false;
    if (box.checked && wasPreviouslyUnchecked) {
      newlyChecked.push(box);
    }
  }
  
  return newlyChecked;
}

/**
 * Detects if multiple tasks were completed in a single iteration.
 * 
 * @param {string} beforePlan - Plan text before changes
 * @param {string} afterPlan - Plan text after changes
 * @param {Object} parsedTaskBefore - Parsed task structure before changes (optional)
 * @param {Object} parsedTaskAfter - Parsed task structure after changes (optional)
 * @returns {boolean} true if multiple tasks were completed
 */
function detectMultiTaskCompletion(beforePlan, afterPlan, parsedTaskBefore = null, parsedTaskAfter = null) {
  const newlyChecked = compareCheckboxDiffs(beforePlan, afterPlan);
  
  // If less than 2 tasks checked, no multi-task completion
  if (newlyChecked.length < 2) {
    return false;
  }
  
  // Extract phase information from the plan text
  const phaseMap = new Map(); // line -> phase
  const lines = afterPlan.split(/\r?\n/);
  let currentPhase = null;
  let hasPhaseMarkers = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const phaseMatch = line.match(/<!--\s*loopy:phase\s+(\S+)\s*-->/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1];
      hasPhaseMarkers = true;
    }
    phaseMap.set(i + 1, currentPhase);
  }
  
  // If no phase markers found, use original behavior (multi-task = violation)
  if (!hasPhaseMarkers) {
    return true;
  }
  
  // Get phases of newly checked tasks
  const phasesOfCheckedTasks = new Set();
  for (const box of newlyChecked) {
    const phase = phaseMap.get(box.line);
    if (phase) {
      phasesOfCheckedTasks.add(phase);
    }
  }
  
  // Trigger violation if checked tasks span multiple phases
  if (phasesOfCheckedTasks.size > 1) {
    return true;
  }
  
  // Allow multiple tasks in the same phase
  return false;
}

/**
 * Detects if newly completed tasks span multiple phases.
 *
 * @param {string} beforePlan - Plan text before changes
 * @param {string} afterPlan - Plan text after changes
 * @returns {boolean} true if multiple phases were crossed
 */
function detectPhaseCrossing(beforePlan, afterPlan) {
  const newlyChecked = compareCheckboxDiffs(beforePlan, afterPlan);

  if (newlyChecked.length < 2) {
    return false;
  }

  const phaseMap = new Map();
  const lines = afterPlan.split(/\r?\n/);
  let currentPhase = null;
  let hasPhaseMarkers = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const phaseMatch = line.match(/<!--\s*loopy:phase\s+(\S+)\s*-->/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1];
      hasPhaseMarkers = true;
    }
    phaseMap.set(i + 1, currentPhase);
  }

  if (!hasPhaseMarkers) {
    return false;
  }

  const phasesOfCheckedTasks = new Set();
  for (const box of newlyChecked) {
    const phase = phaseMap.get(box.line);
    phasesOfCheckedTasks.add(phase ?? "__unphased__");
  }

  return phasesOfCheckedTasks.size > 1;
}

module.exports = {
  parseTask,
  getTaskLine,
  getCurrentTask,
  getCurrentPhaseSection,
  toSlug,
  parseCheckboxes,
  compareCheckboxDiffs,
  detectMultiTaskCompletion,
  detectPhaseCrossing,
};
