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
> Quickstart: to autogenerate this file, run:
>   loopy --prompt "Short description of the change"
>
> If you don't pass --prompt, you can create/edit this plan file manually and run:
>   loopy
>
> Tip: if the loop is interrupted, resume with:
>   loopy --continue

<!-- loopy:seed -->
<!-- The initial prompt seed is stored here when you use --prompt. Loopy auto-generates this plan from that seed. -->

## Phase: plan
<!-- loopy:phase plan -->
- [ ] Write a short problem statement and non-goals.
- [ ] Identify dependencies, env vars, and risky areas.
- [ ] Decide on a rollback plan if tests fail.

## Phase: implement
<!-- loopy:phase implement -->
- [ ] Implement the core feature behind a flag (if needed).
- [ ] Add coverage for edge cases and error paths.
- [ ] Ensure logging/redaction stays intact.

## Phase: verify
<!-- loopy:phase verify -->
- [ ] Run the test suite and record results.
- [ ] Validate with a manual smoke test.
