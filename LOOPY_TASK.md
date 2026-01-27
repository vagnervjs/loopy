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
  - id: define-task-file-contract
    title: Define task-file contract
    stop_on: all_checked
  - id: support-markdown-and-any-file
    title: Support markdown and any file
    stop_on: all_checked
  - id: update-cli-and-prompts
    title: Update CLI and prompts
    stop_on: all_checked
  - id: add-tests-and-examples
    title: Add tests and examples
    stop_on: tests_pass
    test_command: npm test
---

# Task

<!-- loopy:seed make the task-file accept any type of file, primarilly markdown, and it should be an initial prompt with requirements or idea for implementation, like a PRD.md file -->

## Phase: define-task-file-contract
<!-- loopy:phase define-task-file-contract -->

- [x] Specify what "task-file" means now (any extension, preferred .md) and how it differs from existing LOOPY_TASK.md usage.
- [x] Define how the file content is used as an "initial prompt" (where it is injected, ordering vs other prompts, and how to combine with CLI flags).
- [x] Document validation rules (file must exist, non-empty recommended, max size/trim behavior, encoding expectations).

## Phase: support-markdown-and-any-file
<!-- loopy:phase support-markdown-and-any-file -->

- [x] Remove/relax any extension filtering so the task-file can be any file type while still reading it as text.
- [x] Ensure markdown files are preserved verbatim (including headings/lists) when passed into the prompt.
- [x] Add safe normalization (trim excessive leading/trailing whitespace, preserve intentional newlines) and clear error messages on read/parse failures.

## Phase: update-cli-and-prompts
<!-- loopy:phase update-cli-and-prompts -->

- [x] Update CLI help/docs to describe task-file as a PRD-style requirements/implementation-idea input.
- [x] Ensure the task-file content is clearly labeled in the final prompt (e.g., "Task file (PRD):") to reduce model confusion.
- [x] Confirm examples/defaults still work (existing `examples/LOOPY_TASK.md`, `examples/task.txt`) and adjust naming/wording as needed.

## Phase: add-tests-and-examples
<!-- loopy:phase add-tests-and-examples -->

- [x] Add tests covering .md and arbitrary extensions (e.g., .txt, .rst) being accepted and included in the composed prompt.
- [x] Add tests for missing file, unreadable file, and empty content behavior.
- [x] Add/update an example PRD-style markdown task-file demonstrating requirements and implementation ideas.
