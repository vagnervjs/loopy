# PRD: Loopy (Loop Runner)

## Problem Statement
Build a Node.js CLI that runs a coding agent loop reliably, preserving state in files/git and avoiding context pollution, while giving clear progress and safety controls.

## Goals
- Enable repeatable, long-running agent loops with simple prompts and durable state.
- Provide guardrails (rotation, gutter detection, stop conditions) to avoid drift.
- Make progress and failures observable through logs and task status.

## Non-Goals
- Replacing the underlying agent/LLM tooling (the CLI will call an external agent).
- Building a GUI or hosted service.
- Full automation of human review/approval workflows.

## Users & Context
- Primary user: developer running autonomous coding sessions on a local repo.
- Secondary user(s): team leads reviewing progress logs.
- Environment: local terminal (macOS/Linux), git repo present.

## Scope
- In scope: CLI commands, loop orchestration, task/prompt ingestion, logs, safety controls.
- Out of scope: building a new agent, model selection UX, cloud execution.

## Requirements
### Functional
- [F1] CLI supports `loop` (repeat) command; single iteration via `--max-iterations 1`.
- [F2] Reads plan definition from `.loopy/LOOPY_PLAN.md` (front matter + checklist).
- [F3] Generates/uses a single prompt source (e.g., `.loopy/PROMPT.md`) each iteration.
- [F4] Executes a configured agent command (e.g., `cursor-agent`, `claude`, `amp`) with stdin from prompt.
- [F5] Writes `.loopy/activity.log` with per-iteration events and outcomes.
- [F6] Tracks progress in `.loopy/progress.md` (iteration count, last status, last test run).
- [F7] Maintains `.loopy/guardrails.md` and appends “Signs” after failure patterns.
- [F8] Token/size tracking: approximate by counting bytes read/written per iteration.
- [F9] Context rotation: when token/size threshold breached, start next iteration with a “fresh” prompt and only persisted state (task, guardrails, progress).
- [F10] Gutter detection: detect repeated failures (same command error ≥3 times) or file thrashing and record in guardrails.
- [F11] Plan completion detection: stop when all checkboxes in `.loopy/LOOPY_PLAN.md` are checked.
- [F12] Safety caps: max iterations, max wall time, and backoff between iterations.
- [F13] Optional hooks: `preIteration`, `postIteration`, `onFailure` shell hooks.
- [F14] Optional test hook: run `test_command` from task front matter; record pass/fail.
- [F15] Graceful stop: SIGINT/SIGTERM writes final status and exits cleanly.
- [F16] Documentation: includes a `README.md` with setup, example `LOOPY_PLAN.md`, command usage, flags, and troubleshooting.

### Non-Functional
- [N1] Performance: loop overhead < 500ms per iteration excluding agent runtime.
- [N2] Security/Privacy: redact secrets from logs; never log full env vars.
- [N3] Reliability: survives agent crashes; marks iteration as failed and continues based on policy.
- [N4] Portability: Node 18+ on macOS/Linux; no OS-specific dependencies.
- [N5] Observability: logs are human-readable and append-only.

## User Stories (MVP)
- As a developer, I want to run `loopy loop` overnight and wake up to a progress log.
- As a developer, I want to run a single iteration to validate the prompt.
- As a developer, I want the loop to stop when success criteria are met.

## Success Metrics
- 90%+ of runs produce at least one successful iteration without manual intervention.
- Median setup time from install to first loop < 5 minutes.
- 0 critical failures where logs/state are corrupted after forced stop.

## Risks & Mitigations
- Runaway cost or time → default caps, explicit `--max-iterations`, `--max-minutes`.
- Repo damage or drift → encourage frequent commits; optional “dirty repo” warning.
- Stuck loop (gutter) → failure pattern detection with automatic cooldown and guardrail update.

## Open Questions
- Which agent CLI(s) must be supported out of the box?
- Should the tool create commits automatically or just suggest them?
- Exact format of `.loopy/LOOPY_PLAN.md` front matter and required fields?
- Default thresholds for warning/rotate based on byte count?

## Assumptions
- The user provides an agent command that can read prompt from stdin.
- The repo is a git workspace and users are comfortable with frequent commits.
- Plan success is represented as checkbox completion in `.loopy/LOOPY_PLAN.md`.
