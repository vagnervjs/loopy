---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: "loopy/refactor"
  commit: true
---
# Task

- [x] refactor: Finalize `.loopy/` defaults and paths.
- [x] refactor: Use `LOOPY_TASK.md` for task definitions.
- [x] refactor: Update docs, examples, and tests to use Loopy naming.
