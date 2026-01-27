# PRD: Loopy Auto-Phase (Autonomous Task Planning)

## Problem Statement
Loopy currently requires users to manually structure tasks. We need a default, low-effort workflow where Loopy generates a phased plan from a simple prompt and manages progression automatically.

## Goals
- Default to autonomous phase planning with minimal user input.
- Allow a single prompt to create or update `.loopy/LOOPY_PLAN.md`.
- Make phase execution predictable, observable, and resumable.
- Keep usage simple: one command should “just work.”

## Non-Goals
- Building a new agent or model selector.
- GUI or web dashboard work.
- Perfect planning accuracy (must be robust to imperfect plans).

## Users & Context
- Primary user: developer running autonomous loops in a local git repo.
- Environment: local terminal (macOS/Linux), Node 18+.

## Scope
- In scope: auto-phase generation, task file rewrite, phase execution/advancement, status tracking, docs.
- Out of scope: cloud execution, persistent remote services.

## Requirements
### Functional
- [F1] Loopy supports an initial prompt input to generate/update `.loopy/LOOPY_PLAN.md`.
- [F2] Auto-phase is enabled by default; it uses the configured agent to propose phases from task text.
- [F3] Supports a phase schema in front matter: `phases` array and `phase_defaults`.
- [F4] Supports `stop_on` criteria per phase (e.g., `all_checked`, `tests_pass`) and optional `test_command`.
- [F5] Scopes checklist evaluation to the current phase section.
- [F6] Tracks `currentPhase` and phase history in `.loopy/state.json` and progress output.
- [F7] CLI flags: `--phase`, `--phase-only`, `--skip-phase`, and `--auto-phase` (explicit toggle).
- [F8] Optional confirmation before rewriting `.loopy/LOOPY_PLAN.md` via `--confirm` (default is automatic).
- [F9] Backward compatible: if phases are absent and auto-phase is disabled, behavior matches current loop.
- [F10] Documentation: README includes quickstart with one-command flow and phase format reference.

### Non-Functional
- [N1] Minimal effort UX: a single command with an initial prompt should generate a usable plan.
- [N2] Reliability: if auto-phase fails, Loopy falls back to the original task without blocking.
- [N3] Observability: activity log includes phase transitions and auto-phase decisions.

## User Stories
- As a developer, I can run `loopy loop --prompt "<task>"` and get a phased plan automatically.
- As a developer, I can opt into a confirmation prompt before the task file is rewritten.
- As a developer, I can resume a loop and Loopy continues from the current phase.

## Success Metrics
- 90%+ of runs produce an auto-phase plan without manual edits.
- Median time from prompt to first iteration < 2 minutes.
- Low failure rate from auto-phase rewrite errors.

## Risks & Mitigations
- Agent unavailability → fall back to existing task format; log warning.
- Poor phase quality → allow manual edits and explicit `--phase` selection.
- Unexpected file rewrite → confirmation step via `--confirm` flag.

## Open Questions
- What is the best default prompt template for phase generation?
- Should auto-phase run on every loop start or only when no phases exist?
- What is the ideal phase schema for teams (minimum required fields)?
