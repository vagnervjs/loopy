# PRD: Loopy Log UX Refresh

## Problem Statement
Loopy’s current CLI logs are dense and hard to scan, making it difficult to quickly understand iteration boundaries, timing, and progress at a glance.

## Goals
- Make logs easier to read and understand with clear structure and spacing.
- Make iteration boundaries and status updates immediately scannable.
- Standardize timestamp/date presentation without relying on heavy color use.

## Non-Goals
- Building an interactive TUI or curses-based UI.
- Changing log semantics or adding new data sources.
- Replacing the plain-text output with JSON-only output.

## Users & Context
- Primary user: Developers running Loopy in a terminal during local work.
- Secondary user(s): CI log readers and teammates reviewing logs.
- Environment: CLI terminals on macOS/Linux; output may be piped to files.

## Scope
- In scope: Structured iteration blocks, blank lines between iterations, consistent timestamp formatting, minimal visual emphasis, optional compact/verbose modes.
- Out of scope: New log events, interactive controls, or GUI dashboards.

## Requirements
### Functional
- [F1] Group logs into clearly delimited iteration sections with a blank line before and after each iteration block.
- [F2] Add a single-line iteration header that includes iteration number, phase, and start time.
- [F3] Standardize timestamps to local time in the format `YYYY-MM-DD HH:mm:ss` (no milliseconds).
- [F4] Preserve machine-friendly plain text; no reliance on color for meaning.
- [F5] Provide a `--no-color` or `NO_COLOR` compliant mode that is fully readable.
- [F6] Keep core log tags (`[loopy]`, `[info]`, etc.) but align or format them for scanability.
- [F7] Ensure output remains readable in 80–120 column terminals with graceful wrapping.
- [F8] Use lightweight formatting utilities (e.g., minimal ANSI helpers, string-width/wrapping) rather than heavy TUI frameworks.
- [F9] Optional enhancement: show iteration duration in the footer when available.

### Non-Functional
- [N1] Performance: Log formatting must be streaming-safe and add negligible latency.
- [N2] Security/Privacy: No additional sensitive data should be introduced by formatting changes.
- [N3] Accessibility: Output must be understandable without color and readable by screen readers.

## User Stories (MVP)
- As a developer, I want iteration blocks separated by blank lines so that I can scan progress quickly.
- As a developer, I want timestamps to be consistent and local so that I can compare durations easily.
- As a CI log reader, I want minimal color usage so that logs remain clear in plain text.

## Success Metrics
- Reduce average time to locate iteration status in a log by 50% in user testing.
- 90% of log lines fit within 120 columns without truncation in standard terminals.
- 0 regressions in log parsing by existing CI or scripts.

## Risks & Mitigations
- Log parsers may depend on current formatting -> Keep core tokens and provide a compatibility mode or stable prefixes.
- Narrow terminals may wrap awkwardly -> Use consistent indentation and soft wrapping with line width awareness.
- Over-formatting reduces readability in CI -> Default to minimal styling with a `--plain` option.

## Open Questions
- None.

## Assumptions
- Log output is controlled in a single formatting layer that can be updated.
- Users prefer minimal styling and can accept small layout changes if tokens remain stable.
