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
  branch: "ralph/status-1"
  commit: true
---
# Task

- [x] feat: Add a CLI help command.
- [x] feat: Implement loop guardrails.
- [x] docs: Update README with usage instructions.
- [x] feat: Add optional git branch creation support (e.g., flag or task front matter).
- [x] feat: Add optional git commit support with a configurable message template.
- [x] feat: Add optional git worktree support (create/switch worktree before iteration).
- [x] docs: Document git support in README with examples and safety notes.
- [x] feat: Add live streaming of agent stdout/stderr to a log file (e.g. .ralph/agent_stream.log).
- [x] feat: Add optional --stream flag to mirror agent output to terminal.
- [x] docs: Document streaming in README.
- [x] feat: Add `loopy status` command that prints summary from `.ralph/state.json`.
- [x] feat: Include: iteration, last status, last test, last error, last bytes, updated at.
- [x] feat: Handle missing/invalid `.ralph/state.json` with a friendly message and exit code 1.
- [x] Add tests covering status output and missing state file.
- [x] Document the new command in `README.md`.
- [x] Print status on the terminal for every step
