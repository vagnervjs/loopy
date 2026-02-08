/**
 * Detect file thrashing and compute an escalation level based on
 * per-file thrash history across the entire run.
 *
 * Returns:
 *   thrash:    true when the immediate thrash count (>= 3) fires
 *   level:     0 = no thrash, 1 = first trigger (pause), 2 = second (re-scope),
 *              3+ = third+ (block task & skip)
 *   files:     the files that triggered thrashing (for logging)
 *   state:     updated state object
 */
function detectThrash(state, files, previousState) {
  if (!files || files.length === 0) return { thrash: false, level: 0, files: [], state };
  const signature = files.sort().join(",");
  const newState = { ...state };
  // Compare against the *previous* iteration's status and file signature
  // (from the persisted state loaded at the start of the iteration) to
  // avoid false positives where the current iteration's failure status
  // is checked against itself.
  const prev = previousState || state;
  if (prev.lastFileSignature === signature && prev.lastStatus === "failure") {
    newState.fileThrashCount = (prev.fileThrashCount || 1) + 1;
  } else {
    newState.fileThrashCount = 1;
  }
  newState.lastFileSignature = signature;

  const isThrashing = newState.fileThrashCount >= 3;

  if (!isThrashing) {
    return { thrash: false, level: 0, files: [], state: newState };
  }

  // Update per-file thrashHistory — increment count for every file involved
  const thrashHistory = { ...(newState.thrashHistory || {}) };
  let maxFileLevel = 0;
  const thrashingFiles = [];
  for (const file of files) {
    const count = (thrashHistory[file] || 0) + 1;
    thrashHistory[file] = count;
    if (count > maxFileLevel) maxFileLevel = count;
    thrashingFiles.push(file);
  }
  newState.thrashHistory = thrashHistory;

  // Reset the immediate counter so the next cycle starts fresh
  newState.fileThrashCount = 1;

  // Escalation level = max thrash count across the involved files
  // 1 = first trigger, 2 = second, 3+ = third+
  const level = Math.min(maxFileLevel, 3);

  return { thrash: true, level, files: thrashingFiles, state: newState };
}

function detectRepeatFailure(state, errorSignature, limit = 3) {
  if (!errorSignature) return { repeated: false, state };
  const newState = { ...state };
  const counts = { ...(state.errorCounts || {}) };
  counts[errorSignature] = (counts[errorSignature] || 0) + 1;
  newState.errorCounts = counts;
  return { repeated: counts[errorSignature] >= limit, state: newState };
}

module.exports = {
  detectThrash,
  detectRepeatFailure,
};
