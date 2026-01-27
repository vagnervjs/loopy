---
agent_command: cursor-agent
test_command: npm test
max_iterations: 50
max_minutes: 120
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: loopy/cli-refactor
  commit: false
  commit_message: 'loopy: {change_type} {task_summary}'
phase_defaults:
  stop_on: all_checked
phases:
  - id: identify-prompt-seed-entrypoints
    title: Find all --prompt seed paths
    stop_on: all_checked
  - id: implement-preloop-plan-generation
    title: Ensure plan is generated before looping
    stop_on: all_checked
  - id: clarify-user-facing-behavior
    title: Explain consistent seed behavior
    stop_on: all_checked
  - id: add-tests-and-examples
    title: Cover prompt seed modes
    stop_on: all_checked
---

# Plan

<!-- loopy:seed Explain that all --prompt seeds will generate/update the plan before looping, regardless if is inline, file or stdin -->

## Phase: identify-prompt-seed-entrypoints
<!-- loopy:phase identify-prompt-seed-entrypoints -->

- [x] Locate how --prompt is parsed and represented (inline vs file vs stdin).
- [x] List all code paths that consume the prompt seed before starting the loop.
- [x] Identify the current point where plan generation/update occurs relative to the loop start.

## Phase: implement-preloop-plan-generation
<!-- loopy:phase implement-preloop-plan-generation -->

- [x] Refactor so any provided --prompt seed triggers plan generate/update exactly once before looping begins.
- [x] Ensure behavior is identical for inline, file, and stdin sources.
- [x] Preserve existing behavior when no --prompt seed is provided.

## Phase: clarify-user-facing-behavior
<!-- loopy:phase clarify-user-facing-behavior -->

- [x] Update CLI help/docs text to state that all --prompt seeds generate/update the plan before looping.
- [x] Add a short rationale/notes section clarifying that seed source (inline/file/stdin) does not change this behavior.
- [x] Ensure wording matches current terminology used in the project (plan, loop, seed).

## Phase: add-tests-and-examples
<!-- loopy:phase add-tests-and-examples -->

- [x] Add/extend tests that assert plan generation happens before the first loop iteration for each seed mode.
- [x] Add a minimal example demonstrating inline, file, and stdin usage leading to the same pre-loop plan update.
- [ ] Verify no regressions in non-seeded runs. (Note: command execution is blocked in this session, so tests can’t be run here.)
