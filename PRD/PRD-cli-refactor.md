# PRD: CLI Refactor + Plan Workflow

## Context
This PRD captures the CLI refactor and plan/prompt workflow changes. It documents both the intended UX and the resulting behavior.

## Problem Statement
The previous CLI flow required too many flags and manual steps to start a loop. The goal is to make the loop easier to start, clearer to resume, and more predictable when generating/updating the plan file.

## Goals
- Reduce time‑to‑first‑loop with a minimal command surface.
- Standardize plan + prompt handling (inline, file, stdin).
- Improve discoverability of help text and examples.
- Keep advanced/legacy flags available while guiding users to the new flow.

## Non‑Goals
- Changing the underlying agent CLI behavior.
- Replacing the loop core or guardrail model.
- Building a GUI or hosted service.

## Requirements
### Functional
- **Default command**: Running `loopy` with no subcommand starts a loop (alias of `loopy loop`).
- **Plan file**: The loop reads `.loopy/LOOPY_PLAN.md` by default.
- **Seed prompt support**:
  - `--prompt "<text>"` (inline)
  - `--prompt @path/to/file` (file input)
  - `--prompt -` (stdin)
  - All prompt forms generate or update the plan file before looping.
- **Plan generation behavior**:
  - If the plan file does not exist, it is generated from the seed prompt.
  - If it exists and a seed prompt is provided, it is updated.
  - The seed text is included in `.loopy/PROMPT.md` under a plan‑seed section.
- **Hint commands**:
  - `loopy hint "<text>"` appends to `.loopy/hints.md`.
  - `loopy hint --pop` removes the last hint.
  - `loopy hint --reset` clears all hints (and related state where applicable).
- **Status command**:
  - `loopy status` prints iteration, current phase, last error/test, and hint summary.
- **Reset command**:
  - `loopy reset` archives all `.loopy/` files to `.loopy/archive/reset-<timestamp>/` for a clean start.
- **Help output**:
  - Reorganized with a minimal “happy path” and an advanced flags section.
- **Backward compatibility**:
  - Legacy flags are still supported with warnings where behavior changed.

### Non‑Functional
- **Docs**: README updated with quickstart, prompt/plan behavior, and examples.
- **Tests**: Added/updated tests for prompt ingestion, hint pop/reset, status, and default loop behavior.
- **Defaults**: Clear default paths are documented and consistent with runtime behavior.

## UX Plan (Refactor Steps)
1) **Define the target UX (minimal commands first)**
   - `loopy --prompt "..."` (default auto‑phase + generate/update `.loopy/LOOPY_PLAN.md`)
   - `--prompt` accepts inline text or a file reference (e.g., `--prompt @path/to/prompt.md`)
   - `loopy status` (iteration, phase, last error, hints)
   - `loopy hint "..."` (mid‑loop context injection)
   - `loopy reset` (archive `.loopy/ files to clean state)
   - Advanced flags (`--phase`, `--phase-only`, `--skip-phase`, `--auto-phase`) live in an “Advanced” section.
   - No subcommand runs iterations by default, and this is documented in help.
2) **Refactor CLI surface + remove redundancy**
   - Consolidate around the default Loopy invocation as the primary path.
   - Standardize prompt ingestion: inline `--prompt` or `@file` to generate/update `.loopy/LOOPY_PLAN.md`.
   - Remove or simplify flags that duplicate the new commands.
3) **Refactor core implementation for clarity**
   - Consolidate CLI parsing, plan creation, and loop execution into a clean pipeline.
   - Remove legacy paths or logic that only exists for old naming/flow.
   - Ensure new commands reuse shared helpers instead of duplicating logic.
4) **State + prompt wiring**
   - Add `.loopy/hints.md` (or similar) and include it in prompt formatting.
   - Expand `.loopy/state.json` for `currentPhase`, phase history, and last hint.
   - Improve `loopy status` output format.
5) **Tests**
   - `loopy --prompt` generates `.loopy/LOOPY_PLAN.md` and auto‑phase plan.
   - `loopy --prompt @file` works the same.
   - `loopy status` output covers iteration, phase, last error, hints.
   - `loopy hint` appends and is reflected in next prompt.
   - `loopy reset` archives `.loopy/` files and provides clean state.
6) **Docs**
   - README quickstart (one‑command flow).
   - Document status, hint, reset.
   - Explain plan file location + migration.
   - Advanced flags section.

## User Stories
- As a developer, I can start the loop with a single prompt string.
- As a developer, I can feed a PRD file as a seed prompt.
- As a developer, I can resume or continue without re‑passing a prompt.
- As a developer, I can add or remove hints mid‑loop.

## Risks & Mitigations
- **Accidental plan overwrite** → documented prompt behavior + tests for seed inputs.
- **User confusion on legacy flags** → warnings + help text updates.

## Open Questions
- Should prompt confirmation be opt‑in or always automatic?
- Should the plan file name be fully migrated from `LOOPY_TASK.md` to `LOOPY_PLAN.md` in all downstream tooling?
