---
agent_command: cursor-agent
test_command: npm test
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: loopy/auto-phase
  commit: true
  commit_message: 'loopy: {change_type} {task_summary}'
phase_defaults:
  stop_on: all_checked
phases:
  - id: discovery
    title: Understand current prompt flow
    stop_on: all_checked
  - id: cli-args
    title: Add file-based prompt option
    stop_on: all_checked
  - id: prompt-loading
    title: Load task prompt from file
    stop_on: all_checked
  - id: tests-docs
    title: Validate, test, and document
    stop_on: all_checked
---

# Task

<!-- loopy:seed Accept task-prompt from a file instead of inline string -->

## Phase: discovery
<!-- loopy:phase discovery -->

- [x] Identify where the task prompt is currently accepted (inline string) and how it flows into planning/execution.
- [x] Locate existing argument parsing and config precedence rules (CLI vs config vs defaults).
- [x] Decide expected behavior when both inline prompt and file prompt are provided (precedence + error/merge strategy).

## Phase: cli-args
<!-- loopy:phase cli-args -->

- [x] Add a CLI flag for file input (e.g., `--task-file <path>` or `--prompt-file <path>`) with clear help text.
- [x] Support `-` (stdin) as an input option if consistent with the CLI’s style.
- [x] Update validation so missing/empty values produce actionable error messages.

## Phase: prompt-loading
<!-- loopy:phase prompt-loading -->

- [x] Implement reading the prompt from disk (encoding, trimming rules, empty-file handling).
- [x] Resolve paths reliably (relative to cwd) and produce friendly errors for not-found/permission issues.
- [x] Ensure downstream prompt consumers receive the exact same structure as the previous inline prompt path.

## Phase: tests-docs
<!-- loopy:phase tests-docs -->

- [x] Add/adjust tests to cover file prompt success, missing file, empty file, and precedence behavior.
- [x] Update `examples/` and CLI usage docs to show file-based prompt usage.
- [ ] Run existing test suite and ensure no regressions in the inline prompt behavior.
  - Note: I can't execute `npm test` from this session (command execution is blocked here). Please run `npm test` locally.
