---
agent_command: cursor-agent
test_command: npm test
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: loopy/cli-refactor
  commit: true
  commit_message: 'loopy: {change_type} {task_summary}'
phase_defaults:
  stop_on: all_checked
  test_command: npm test
phases:
  - id: plan
    title: Plan
    stop_on: all_checked
  - id: implement
    title: Implement
    stop_on: all_checked
  - id: verify
    title: Verify
    stop_on:
      - all_checked
      - tests_pass
    test_command: npm test
---

# Task

<!-- loopy:seed Plan: CLI Simplification + Refactor

  1. Define the target UX (minimal commands first)
      - loopy loop --prompt "..." (default auto‑phase + generate/update LOOPY_PLAN.md)
      - --prompt accepts inline text or a file reference (e.g., --prompt @path/to/prompt.md)
      - loopy status (iteration, phase, last error, hints)
      - loopy hint "..." (mid‑loop context injection)
      - loopy init (scaffold LOOPY_PLAN.md + .loopy/ + example)
      - Advanced flags (--phase, --phase-only, --skip-phase, --auto-phase) go under an “Advanced” section in help.
      - No subcommand defaults to loop, and this is documented in help.
  2. Refactor CLI surface + remove redundancy
      - Consolidate around loop as the primary path.
      - Standardize prompt ingestion: inline --prompt or @file to generate/update LOOPY_PLAN.md.
      - Deprecate LOOPY_TASK.md (auto‑detect + warning) in favor of LOOPY_PLAN.md.
      - Remove or simplify flags that duplicate the new commands.
  3. Refactor core implementation for clarity
      - Consolidate CLI parsing, plan creation, and loop execution into a clean pipeline.
      - Remove legacy paths or logic that only exists for old naming/flow.
      - Ensure new commands reuse shared helpers instead of duplicating logic.
  4. State + prompt wiring
      - Add .loopy/hints.md (or similar) and include it in prompt formatting.
      - Expand .loopy/state.json for currentPhase, phase history, and last hint.
      - Improve loopy status output format.
  5. Tests
      - loopy loop --prompt generates LOOPY_PLAN.md and auto‑phase plan.
      - loopy loop --prompt @file works the same.
      - loopy status output covers iteration, phase, last error, hints.
      - loopy hint appends and is reflected in next prompt.
      - loopy init scaffolds expected files.
      - Back‑compat: if LOOPY_TASK.md exists and LOOPY_PLAN.md does not, Loopy uses it and warns.
  6. Docs
      - README quickstart (one‑command flow).
      - Document status, hint, init.
      - Explain LOOPY_PLAN.md rename + migration.
      - Advanced flags section. -->

## Phase: plan
<!-- loopy:phase plan -->

- [x] Plan: CLI Simplification + Refactor

### Concrete implementation plan (this repo)

- **Target UX (surface)**
  - **Default command**: running `loopy` with no subcommand behaves like `loopy loop` (documented in help).
  - **Primary path**: `loopy loop --prompt "<seed>"` generates/updates `LOOPY_PLAN.md` (auto‑phase on by default), then runs.
  - **Prompt ingestion**:
    - `--prompt "<inline text>"` → inline seed
    - `--prompt @path/to/file.md` → read seed from file (any extension)
    - `--prompt -` → read seed from stdin (keep current stdin behavior)
  - **New commands**
    - `loopy status`: include iteration, phase, last error, and hint summary.
    - `loopy hint "<text>"`: append to `.loopy/hints.md`, record `lastHint` in `.loopy/state.json`, and ensure the next generated `PROMPT.md` includes hints.
    - `loopy init`: scaffold `.loopy/` + `LOOPY_PLAN.md` (and a minimal example seed), without overwriting existing files.

- **Back-compat + deprecations**
  - **File rename**: default task doc becomes `LOOPY_PLAN.md`.
    - If `LOOPY_PLAN.md` is missing and `LOOPY_TASK.md` exists (and user didn’t pass `--task`), use `LOOPY_TASK.md` **and warn** to stderr about migration.
  - **Flag rename**:
    - Introduce new seed flag `--prompt` (inline / `@file` / `-`).
    - Keep `--task-prompt` / `--task-file` as deprecated aliases for one release cycle (warn to stderr).
  - **Resolve the `--prompt` collision** (currently used for prompt *output* file):
    - Rename prompt output file flag to `--prompt-out` (default `PROMPT.md`), keep old `--prompt <file>` as deprecated alias **only when** `--prompt` is not also used as a seed flag (i.e., we’ll treat `--prompt` as seed and move output to `--prompt-out` going forward).

- **Code changes (high-level mapping)**
  - `src/config.js`
    - Change `DEFAULTS.taskFile` → `LOOPY_PLAN.md`.
    - Add `DEFAULTS.hintsFile` → `.loopy/hints.md`.
    - Update `mergeConfig()` to support new seed flag (`--prompt`) and new output flag (`--prompt-out`).
  - `src/cli.js`
    - Default command to `loop` when no subcommand is provided.
    - Add `hint` + `init` commands.
    - Rework help text: “Common” vs “Advanced” sections; document default-to-loop.
  - `src/loop.js`
    - Refactor seed loading into a single path that understands inline / `@file` / stdin.
    - Implement `LOOPY_PLAN.md` default + `LOOPY_TASK.md` fallback warning.
    - Ensure prompt generation includes hints (by passing them into `formatPrompt()`).
  - `src/prompt.js`
    - Add `## Hints` section sourced from `.loopy/hints.md` (truncate/summarize if needed to avoid ballooning prompts).
    - Rename “Task (LOOPY_TASK.md)” heading to reflect the actual plan/task doc filename (`LOOPY_PLAN.md` by default).
  - New helper (or small additions to `src/fs.js`)
    - Append-to-file helper for hints and safe directory creation (we already have `writeText`, but hints should append).

- **State + status output**
  - Extend `.loopy/state.json` with:
    - `lastHint` (string), `lastHintAt` (ISO), optionally `hintCount` (number)
  - `loopy status` prints those fields (and/or a short preview of the last hint).

- **Tests + docs updates**
  - Update `test/cli.test.js` to cover:
    - `loopy loop --prompt "<inline>"` generates `LOOPY_PLAN.md` (auto‑phase) and includes the seed in `PROMPT.md`.
    - `loopy loop --prompt @file` behaves the same.
    - `loopy hint` appends and is reflected in the next `PROMPT.md`.
    - `loopy status` includes hint info.
    - `loopy init` scaffolds expected files.
    - Back-compat: `LOOPY_TASK.md` used with warning when `LOOPY_PLAN.md` absent.
  - Update `README.md` quickstart + migration notes + “Advanced flags” section.

  1. Define the target UX (minimal commands first)
      - loopy loop --prompt "..." (default auto‑phase + generate/update LOOPY_PLAN.md)
      - --prompt accepts inline text or a file reference (e.g., --prompt @path/to/prompt.md)
      - loopy status (iteration, phase, last error, hints)
      - loopy hint "..." (mid‑loop context injection)
      - loopy init (scaffold LOOPY_PLAN.md + .loopy/ + example)
      - Advanced flags (--phase, --phase-only, --skip-phase, --auto-phase) go under an “Advanced” section in help.
      - No subcommand defaults to loop, and this is documented in help.
  2. Refactor CLI surface + remove redundancy
      - Consolidate around loop as the primary path.
      - Standardize prompt ingestion: inline --prompt or @file to generate/update LOOPY_PLAN.md.
      - Deprecate LOOPY_TASK.md (auto‑detect + warning) in favor of LOOPY_PLAN.md.
      - Remove or simplify flags that duplicate the new commands.
  3. Refactor core implementation for clarity
      - Consolidate CLI parsing, plan creation, and loop execution into a clean pipeline.
      - Remove legacy paths or logic that only exists for old naming/flow.
      - Ensure new commands reuse shared helpers instead of duplicating logic.
  4. State + prompt wiring
      - Add .loopy/hints.md (or similar) and include it in prompt formatting.
      - Expand .loopy/state.json for currentPhase, phase history, and last hint.
      - Improve loopy status output format.
  5. Tests
      - loopy loop --prompt generates LOOPY_PLAN.md and auto‑phase plan.
      - loopy loop --prompt @file works the same.
      - loopy status output covers iteration, phase, last error, hints.
      - loopy hint appends and is reflected in next prompt.
      - loopy init scaffolds expected files.
      - Back‑compat: if LOOPY_TASK.md exists and LOOPY_PLAN.md does not, Loopy uses it and warns.
  6. Docs
      - README quickstart (one‑command flow).
      - Document status, hint, init.
      - Explain LOOPY_PLAN.md rename + migration.
      - Advanced flags section.

## Phase: implement
<!-- loopy:phase implement -->

- [x] Implement: Plan: CLI Simplification + Refactor

  1. Define the target UX (minimal commands first)
      - loopy loop --prompt "..." (default auto‑phase + generate/update LOOPY_PLAN.md)
      - --prompt accepts inline text or a file reference (e.g., --prompt @path/to/prompt.md)
      - loopy status (iteration, phase, last error, hints)
      - loopy hint "..." (mid‑loop context injection)
      - loopy init (scaffold LOOPY_PLAN.md + .loopy/ + example)
      - Advanced flags (--phase, --phase-only, --skip-phase, --auto-phase) go under an “Advanced” section in help.
      - No subcommand defaults to loop, and this is documented in help.
  2. Refactor CLI surface + remove redundancy
      - Consolidate around loop as the primary path.
      - Standardize prompt ingestion: inline --prompt or @file to generate/update LOOPY_PLAN.md.
      - Deprecate LOOPY_TASK.md (auto‑detect + warning) in favor of LOOPY_PLAN.md.
      - Remove or simplify flags that duplicate the new commands.
  3. Refactor core implementation for clarity
      - Consolidate CLI parsing, plan creation, and loop execution into a clean pipeline.
      - Remove legacy paths or logic that only exists for old naming/flow.
      - Ensure new commands reuse shared helpers instead of duplicating logic.
  4. State + prompt wiring
      - Add .loopy/hints.md (or similar) and include it in prompt formatting.
      - Expand .loopy/state.json for currentPhase, phase history, and last hint.
      - Improve loopy status output format.
  5. Tests
      - loopy loop --prompt generates LOOPY_PLAN.md and auto‑phase plan.
      - loopy loop --prompt @file works the same.
      - loopy status output covers iteration, phase, last error, hints.
      - loopy hint appends and is reflected in next prompt.
      - loopy init scaffolds expected files.
      - Back‑compat: if LOOPY_TASK.md exists and LOOPY_PLAN.md does not, Loopy uses it and warns.
  6. Docs
      - README quickstart (one‑command flow).
      - Document status, hint, init.
      - Explain LOOPY_PLAN.md rename + migration.
      - Advanced flags section.

## Phase: verify
<!-- loopy:phase verify -->

- [x] Run tests: npm test
