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
  commit_message: "Loopy {iteration}: {status} ({test})"
---
# Task

- [x] Add a CLI help command.
- [x] Implement loop guardrails.
- [x] Update README with usage instructions.
- [x] Add optional git branch creation support (e.g., flag or task front matter).
- [x] Add optional git commit support with a configurable message template.
- [x] Add optional git worktree support (create/switch worktree before iteration).
- [x] Document git support in README with examples and safety notes.
- [ ] Add live streaming of agent stdout/stderr to a log file (e.g. .ralph/agent_stream.log).
- [ ] Add optional --stream flag to mirror agent output to terminal.
- [ ] Document streaming in README.
