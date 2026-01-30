function detectThrash(state, files) {
  if (!files || files.length === 0) return { thrash: false, state };
  const signature = files.sort().join(",");
  const newState = { ...state };
  if (newState.lastFileSignature === signature && newState.lastStatus === "failure") {
    newState.fileThrashCount = (newState.fileThrashCount || 1) + 1;
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
