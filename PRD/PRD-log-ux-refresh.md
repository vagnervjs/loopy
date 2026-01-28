# PRD: Loopy Log UX Refresh (Delightful CLI)

## Problem Statement
Loopy’s CLI logs are repetitive and visually flat, making it hard to scan iteration boundaries and outcomes quickly. The per-line `[loopy] [info]` prefixes add noise without providing meaningful value.

## Goals
- Create a delightful, premium CLI experience using tasteful colors and emoji.
- Make iteration boundaries, phases, and outcomes instantly scannable.
- Reduce visual noise by removing redundant prefixes and tightening copy.
- Keep timestamps consistent and local for quick time reasoning.
- Improve the structure of log content so the most important events stand out.

## Non-Goals
- Building an interactive TUI or curses-based UI.
- Changing the underlying semantics or adding new data sources.
- Removing the ability to run in plain text (CI/log files).

## Users & Context
- Primary user: Developers running Loopy in a terminal during local work.
- Secondary user(s): CI log readers and teammates reviewing logs.
- Environment: CLI terminals on macOS/Linux; output may be piped to files.

## Scope
- In scope: Visual system (colors, emoji, icons), new log structure, improved copy, iteration header/footer patterns, sample outputs, opt-outs for color/emoji.
- Out of scope: Interactive features, JSON-only logs, telemetry pipelines.

## Log Content & Structure (Target)
- Run header: One block covering loop start, settings, and branch.
- Plan summary: Phases with task counts; avoid repeating the full plan on every iteration.
- Iteration block: Header, grouped activity lines, and a concise results summary.
- Iteration footer: Status, duration, test status, and git summary.
- Run footer: Completion and archive location.

## Visual System
- Color palette: Headers (cyan/blue), success (green), warning (yellow), error (red), meta/dim (gray).
- Emoji/icon set: Use one icon per line to signal intent; provide ASCII fallbacks.
- Styling rules: Use bold for headers, keep color use to 1-2 spans per line, avoid rainbow output.

## Inspiration (CLI Tools)
- `git`: Concise verbs and compact status cues.
- `pnpm`: Grouped steps with subtle, consistent color usage.
- `cargo`: Clear section headers and readable progress summaries.
- `gh`: High-signal summaries with friendly icons.
- `ripgrep`: Tight alignment and low-noise defaults.

## Requirements
### Functional
- [F1] Remove per-line `[loopy] [info]` prefixes; use timestamp + icon + message as the base line format.
- [F2] Add iteration headers like `Iteration 1 · Locate legacy archive usage` and footers like `Iteration 1 complete`.
- [F3] Insert a blank line between major sections and between iterations.
- [F4] Standardize timestamps to local time in the format `YYYY-MM-DD HH:mm:ss` (no milliseconds).
- [F5] Apply a consistent color palette across statuses and section headers.
- [F6] Enable emoji by default with a `--no-emoji` flag providing ASCII alternatives.
- [F7] Provide `--plain` (no color, no emoji) and honor `NO_COLOR`.
- [F8] Improve copy: replace `iter 1` with `Iteration 1`, use clear verbs like "started", "complete", "archived".
- [F9] Show iteration duration in the footer when available.
- [F10] Keep output readable in 80–120 column terminals with graceful wrapping.
- [F11] Provide stable textual markers for parsing (e.g., `Iteration <n> start` and `Iteration <n> complete`).
- [F12] Default to summaries for task lists; add a verbose mode to print full checklists.

### Non-Functional
- [N1] Performance: Log formatting must be streaming-safe and add negligible latency.
- [N2] Security/Privacy: No additional sensitive data should be introduced by formatting changes.
- [N3] Accessibility: Output must be understandable without color and readable by screen readers.
- [N4] Compatibility: Output should render consistently on common terminals (macOS/Linux).

## User Stories (MVP)
- As a developer, I want a beautifully styled log so it feels premium and easy to scan.
- As a developer, I want iteration headers and footers so I can locate progress quickly.
- As a CI log reader, I want a plain output mode that remains readable without color or emoji.

## Success Metrics
- Reduce average time to locate iteration status in a log by 50% in user testing.
- 80%+ of users rate the new log UX 4/5 or higher in a quick survey.
- 90% of log lines fit within 120 columns without truncation in standard terminals.
- 0 regressions in existing log parsing workflows.

## Risks & Mitigations
- Emoji width varies by terminal -> Provide ASCII fallback and `--no-emoji`.
- Colors may look bad in some terminals/CI -> Honor `NO_COLOR` and `--plain`.
- Reduced verbosity may hide details -> Provide a verbose mode for full checklists.

## Example Output (Illustrative)
```
2026-01-27 01:22:00  🚀 Loop start  (max iterations: 50, max minutes: 120, backoff: 5s)
2026-01-27 01:22:00  🌿 Branch     loopy/plan-progress-ux

2026-01-27 01:22:01  📋 Plan       3 phases, 7 tasks
2026-01-27 01:22:01    ▸ Locate legacy archive usage (2)
2026-01-27 01:22:01    ▸ Remove legacy compatibility (3)
2026-01-27 01:22:01    ▸ Update tests and docs (2)

2026-01-27 01:22:02  🔁 Iteration 1 · Locate legacy archive usage
2026-01-27 01:22:02    💬 Prompt saved to .loopy/PROMPT.md
2026-01-27 01:22:02    🤖 Agent run cursor-agent
2026-01-27 01:22:44    ✅ Tasks complete (7/7)
2026-01-27 01:22:45    🧪 Tests     n/a
2026-01-27 01:22:46    🧩 Git       commit 63abff7
2026-01-27 01:22:46  ✅ Iteration 1 complete · Duration 0m 44s

2026-01-27 01:22:47  📦 Archive   .loopy/archive/plan-progress-ux
```

## Work Plan
- Audit current log events and identify duplication/noise.
- Define the target log schema (headers, sections, footers).
- Implement a formatter with color/emoji theming and fallbacks.
- Update CLI flags (`--plain`, `--no-emoji`) and `NO_COLOR` handling.
- Update snapshots/tests and add coverage for formatting rules.
- Update README/docs with new examples and flags.

## Open Questions
- None.

## Assumptions
- Terminals running Loopy can render Unicode emoji, or users will opt out.
- Log output is controlled in a single formatting layer that can be updated.
