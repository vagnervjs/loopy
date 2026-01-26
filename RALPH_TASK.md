---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: "ralph/refactor"
  commit: true
---
# Task

- [x] refactor: Split `src/ralph.js` into focused modules (config, task parsing, git helpers, loop runner, etc).
- [x] refactor: Keep CLI entrypoint thin and move helpers into new files under `src/`.
- [x] refactor: Preserve behavior and update imports/exports.
- [ ] test: Run existing tests and fix any breakage from the refactor.
- [x] docs: Update README if any public APIs or paths change.
