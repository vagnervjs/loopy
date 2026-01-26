---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: "ralph/streaming"
  commit: true
---
# Task

- [x] feat: Add `--version` flag to print the Loopy version.
- [x] test: Add CLI test for `--version` output.
- [x] docs: Document `--version` in README.
