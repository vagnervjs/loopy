---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: "ralph/refactor-2"
  commit: true
---
# Task

- [ ] refactor: Rename `.ralph/` to `.loopy/` and update defaults.
- [ ] refactor: Rename `RALPH_TASK.md` to `LOOPY_TASK.md` and update references.
- [ ] refactor: Update docs, examples, and tests to use Loopy naming.
