# PRD: Example Loopy Task File (Seed Prompt)

## Goal
Add support for a “task seed prompt file” (usually a markdown PRD) that can be passed to Loopy with `--task-file` and included verbatim in the composed prompt.

## Requirements
- Accept any file extension (prefer `.md`).
- Preserve markdown formatting (headings, lists, code blocks).
- Provide friendly errors for missing/empty/unreadable files.

## Implementation notes (idea)
- Read the seed prompt as UTF-8.
- Normalize line endings and trim only empty boundary lines.
- Include the seed prompt in `PROMPT.md` under a clearly labeled section so the agent can reference requirements.

## Acceptance criteria
- Running `loopy run --dry-run --task-file examples/task.md --auto-apply --agent-cmd "<planner>"` produces a `PROMPT.md` that contains this file’s contents under a “Task file (PRD)” section.
