const { toSlug } = require("../task");

function parseSkipPhaseList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => toSlug(s) || s.trim())
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

function pickCurrentPhaseId(parsedTask, state, config, options = {}) {
  const phases = (parsedTask && parsedTask.phases) || [];
  if (!phases.length) return "";
  const ids = phases.map((p) => p.id);
  const skip = new Set(parseSkipPhaseList(config.skipPhase));

  const preferred = toSlug(config.phase) || String(config.phase || "").trim() || String(state.currentPhase || "").trim();
  const preferredId = toSlug(preferred) || preferred;
  const start = preferredId && ids.includes(preferredId) ? preferredId : ids[0];
  const startIdx = Math.max(0, ids.indexOf(start));
  const phaseLocked = Boolean(options && options.phaseExplicit) || Boolean(config.phaseOnly);

  if (phaseLocked) {
    for (let i = 0; i < ids.length; i += 1) {
      const candidate = ids[(startIdx + i) % ids.length];
      if (!skip.has(candidate)) return candidate;
    }
    return start;
  }

  // Prefer the next incomplete phase in strict forward order (no wrap-around).
  // This ensures the plan sequence is respected: once a phase is passed,
  // we never regress to an earlier phase.
  for (let i = startIdx; i < ids.length; i += 1) {
    const candidate = ids[i];
    if (skip.has(candidate)) continue;
    if (isPhaseComplete(parsedTask, candidate, state)) continue;
    return candidate;
  }

  // All phases from startIdx onward are complete or skipped;
  // fall back to the last non-skipped phase.
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    if (!skip.has(ids[i])) return ids[i];
  }
  return start;
}

function phaseStopOn(parsedTask, phaseId) {
  if (!phaseId) return [];
  const phase = (parsedTask.phases || []).find((p) => p.id === phaseId);
  const raw = phase && Array.isArray(phase.stopOn) ? phase.stopOn : phase && phase.stopOn ? [phase.stopOn] : [];
  return raw.map((s) => String(s || "").trim()).filter(Boolean);
}

function phaseCriteria(parsedTask, phaseId) {
  const stopOn = phaseStopOn(parsedTask, phaseId);
  return stopOn.length ? stopOn : ["all_checked"];
}

function phaseTestCommand(parsedTask, phaseId) {
  if (!phaseId) return "";
  const fm = parsedTask.frontMatter || {};
  const phaseDefaults = parsedTask.phaseDefaults || {};
  const phase = (parsedTask.phases || []).find((p) => p.id === phaseId);
  const fromPhase = phase && phase.testCommand ? String(phase.testCommand).trim() : "";
  const fromDefaults = String(phaseDefaults.test_command || phaseDefaults.testCommand || "").trim();
  const fromGlobal = String(fm.test_command || fm.testCommand || "").trim();
  return fromPhase || fromDefaults || fromGlobal || "";
}

function hasPhase(parsedTask, phaseId) {
  if (!phaseId) return false;
  return Boolean((parsedTask.phases || []).find((p) => p.id === phaseId));
}

function isPhaseAllChecked(parsedTask, phaseId) {
  if (!phaseId) return false;
  const sec = parsedTask.phaseSections && parsedTask.phaseSections[phaseId];
  return Boolean(sec && sec.allChecked);
}

function didTestsPass(state) {
  const last = String((state && state.lastTest) || "");
  return /^pass\b/i.test(last.trim());
}

function isPhaseComplete(parsedTask, phaseId, state, { testStatus } = {}) {
  if (!hasPhase(parsedTask, phaseId)) return false;
  const criteria = phaseCriteria(parsedTask, phaseId);
  const needsAllChecked = criteria.includes("all_checked");
  const needsTests = criteria.includes("tests_pass");
  const phaseChecked = isPhaseAllChecked(parsedTask, phaseId);
  const hasTestStatus = typeof testStatus === "string" && testStatus.trim() && testStatus !== "n/a";
  const testsOk = !needsTests || (hasTestStatus ? /^pass\b/i.test(testStatus.trim()) : didTestsPass(state));
  const phaseOk = !needsAllChecked || phaseChecked;
  return phaseOk && testsOk;
}

function computeNextPhaseId(parsedTask, currentPhaseId, config) {
  const phases = parsedTask.phases || [];
  if (!phases.length) return "";
  const ids = phases.map((p) => p.id);
  const skip = new Set(parseSkipPhaseList(config.skipPhase));
  const idx = ids.indexOf(currentPhaseId);
  if (idx < 0) return ids[0];
  for (let i = idx + 1; i < ids.length; i += 1) {
    if (!skip.has(ids[i])) return ids[i];
  }
  return "";
}

function resolvePhaseLabel(parsedTask, phaseId) {
  if (!phaseId) return "";
  const phases = parsedTask && parsedTask.phases;
  if (!Array.isArray(phases)) return String(phaseId);
  const match = phases.find((phase) => phase && String(phase.id || "").trim() === String(phaseId));
  const title = match && String(match.title || "").trim();
  return title || String(phaseId);
}

function areAllPhasesComplete(parsedTask, state, { testStatus } = {}) {
  const phases = (parsedTask && parsedTask.phases) || [];
  if (!phases.length) return true;
  return phases.every((phase) => isPhaseComplete(parsedTask, phase.id, state, { testStatus }));
}

module.exports = {
  areAllPhasesComplete,
  computeNextPhaseId,
  isPhaseComplete,
  parseSkipPhaseList,
  phaseTestCommand,
  pickCurrentPhaseId,
  resolvePhaseLabel,
};
