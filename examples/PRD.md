# PRD: Example Loopy Plan Seed (PRD)

## Goal
Add support for a “plan seed prompt file” (usually a markdown PRD) that can be passed to Loopy with `--prompt @<file>` and included verbatim in the composed prompt.

## Requirements
- Accept any file extension (prefer `.md`).
- Preserve markdown formatting (headings, lists, code blocks).
- Provide friendly errors for missing/empty/unreadable files.

## Implementation notes (idea)
- Read the seed prompt as UTF-8.
- Normalize line endings and trim only empty boundary lines.
- Include the seed prompt in `.loopy/PROMPT.md` under a clearly labeled section so the agent can reference requirements.

## Acceptance criteria
- Running `loopy loop --dry-run --prompt @examples/PRD.md --agent "cursor-agent"` produces a `.loopy/PROMPT.md` that contains this file’s contents under a “Plan seed (PRD)” section.
- Adding `--confirm` prompts before writing or applying plan updates.
