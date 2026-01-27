---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
phase_defaults:
  stop_on: all_checked
  test_command: "npm test"
phases:
  - id: plan
    title: Plan
  - id: implement
    title: Implement
  - id: verify
    title: Verify
    stop_on: [all_checked, tests_pass]
    test_command: "npm test"
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

## Phase: plan
<!-- loopy:phase plan -->
- [ ] Describe the goal, constraints, and approach.

## Phase: implement
<!-- loopy:phase implement -->
- [ ] Implement the requested changes.

## Phase: verify
<!-- loopy:phase verify -->
- [ ] Run tests and validate behavior.

