---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
hooks:
  preIteration: "echo pre"
  postIteration: "echo post"
  onFailure: "echo failed"
git:
  branch: "ralph/streaming"
  commit: true
---
# Task

- [x] Add a CLI help command.
- [x] Implement loop guardrails.
- [x] Update README with usage instructions.
- [x] Add optional git branch creation support (e.g., flag or task front matter).
- [x] Add optional git commit support with a configurable message template.
- [x] Add optional git worktree support (create/switch worktree before iteration).
- [x] Document git support in README with examples and safety notes.
- [x] Add live streaming of agent stdout/stderr to a log file (e.g. .ralph/agent_stream.log).
- [x] Add optional --stream flag to mirror agent output to terminal.
- [x] Document streaming in README.
- [ ] Add `loopy status` command that prints summary from `.ralph/state.json`.
- [ ] Include: iteration, last status, last test, last error, last bytes, updated at.
- [ ] Handle missing/invalid `.ralph/state.json` with a friendly message and exit code 1.
- [ ] Add tests covering status output and missing state file.
- [ ] Document the new command in `README.md`.