---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  # Optional: run inside a worktree (creates if missing)
  # worktree: "../wt/loopy-my-task"
  # worktree_branch: "loopy/my-task"
  # Optional: create/switch branch before running
  # branch: "loopy/my-task"
  # Optional: auto-commit after successful iterations
  # commit: true
  # commit_message: "Loopy {iteration}: {status} ({test})"
hooks:
  preIteration: "echo pre"
  postIteration: "echo post"
  onFailure: "echo failed"
---

# Task

- [ ] Add a CLI help command.
- [ ] Implement loop guardrails.
- [ ] Update README with usage instructions.

