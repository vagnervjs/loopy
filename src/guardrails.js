function detectThrash(state, files, previousState) {
  if (!files || files.length === 0) return { thrash: false, state };
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
  return { thrash: newState.fileThrashCount >= 3, state: newState };
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
