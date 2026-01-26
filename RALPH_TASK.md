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

- [x] feat: Add `--version` flag to print the Loopy version.
- [x] test: Add CLI test for `--version` output.
- [x] docs: Document `--version` in README.
- [x] Add tests covering status output and missing state file.
- [x] Document the new command in `README.md`.
- [x] Print status on the terminal for every step
