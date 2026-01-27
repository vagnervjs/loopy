---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: "loopy/example-plan"
  worktree: "../wt/loopy-example"
  worktree_branch: "loopy/example-plan"
  commit: true
  commit_message: "loopy: {change_type} {task_summary}"
hooks:
  preIteration: "echo pre"
  postIteration: "echo post"
  onFailure: "echo failed"
---
# Plan

> Intended location: `.loopy/LOOPY_PLAN.md`
>
> Tip: if the loop is interrupted, resume with `loopy loop --continue` (works even with staged files).

- [ ] Describe the change you want Loopy to implement.

