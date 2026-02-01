# Loopy Reference

This is the full reference for Loopy. For the quickstart and a concise overview, see [`README.md`](../README.md).

## Common workflows

**Start a new loop (interactive — recommended):**

Simply run `loopy` with no arguments. The tool will interactively prompt you for:
- Agent command (e.g., "cursor-agent", "copilot")
- Task description or plan
- Git branch (optional)

No configuration files needed — just run:

```bash
loopy
```

In build mode (default), Loopy follows tasks from `LOOPY_PLAN.md` and updates progress/checkboxes as work completes.

Loopy also includes `AGENTS.md` and a `specs/` summary in each prompt. If `AGENTS.md` is missing, it bootstraps `.loopy/AGENTS.md` unless `--no-bootstrap-agents` is set.

**Start a new loop (non-interactive — for automation):**
```bash
loopy --agent "cursor-agent" --prompt "Add OAuth login to the app"
```

Plan-only mode generates or updates `LOOPY_PLAN.md` and exits without running build iterations:

```bash
loopy --mode plan --prompt "Add OAuth login to the app"
```

Resume a previous run (requires `.loopy/state.json`):
```bash
loopy --resume
```
Note: `--resume` is resume-only and cannot be combined with `--prompt` or `--plan`.

Run a single iteration:
```bash
loopy --max-iterations 1 --agent "cursor-agent"
```

Check status:
```bash
loopy status
```
Status shows: iteration, current phase, last status, last test, last error, last hint + hint count, last bytes, updated at.

Manage mid-loop hints:
```bash
loopy hint "Focus on fixing the failing test first."
loopy hint --pop
loopy hint --reset
```

Disable streaming when you only want logs:
```bash
loopy --agent "cursor-agent" --prompt @examples/PRD.md --stream=false
```

Help and version:
```bash
loopy help
loopy --version
```

## Input examples

### Prompt from a file or stdin
```bash
loopy --agent "cursor-agent" --prompt @./task.txt
cat ./task.txt | loopy --agent "cursor-agent" --prompt -
```

### Plan seed from a file or stdin (PRD-first)
```bash
# file
loopy --agent "cursor-agent" --plan @./problem.md

# stdin
cat ./problem.md | loopy --agent "cursor-agent" --plan -
```

## Log output
Loopy prints timestamped lines (local time) with a compact icon + message. Default output uses emoji and color.

- Use `--no-emoji` for ASCII icons.
- Use `--plain` for no color and no emoji.
- Set `NO_COLOR=1` to disable ANSI color (emoji remain).
- Use `--verbose=false` to hide full checklist details in the plan summary.
- Stable markers: `Iteration <n> start` and `Iteration <n> complete`.

## Mental model
Loopy treats a markdown plan doc as the source of truth.
Each iteration reads the plan doc, runs the agent, applies guardrails, and updates state.
Completion is driven by checked items, not by agent confidence.

## How Loopy works
1. Loopy reads a plan doc (default: `.loopy/LOOPY_PLAN.md`) on every iteration.
2. If you provide a seed prompt (`--prompt`) or plan seed (`--plan`), Loopy generates/updates the plan doc before looping.
3. When run interactively with a seed, Loopy pauses for plan review before starting iterations.
4. Each iteration runs the agent, optional tests, and updates logs/state.
5. The loop stops when all plan checkboxes are checked or when guardrails stop it.
6. On completion, Loopy archives `.loopy` artifacts to `.loopy/archive/<branch>/` and starts fresh.

## Core concepts

### Plan doc (`--plan-file`, default `.loopy/LOOPY_PLAN.md`)
The plan doc is the durable source of truth for the loop. It contains:

- YAML front matter (agent command, test command, loop limits, git settings, phases)
- The checklist(s) that represent progress and completion

You can point Loopy at any path via `--plan-file <file>`.

Example:
```md
---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
hooks:
  preIteration: "echo pre"
  postIteration: "echo post"
  onFailure: "echo failed"
---

# Plan

- [ ] Add a CLI help command.
- [ ] Implement loop guardrails.
- [ ] Update README with usage instructions.
```

You can also pass `--agent` to override the plan front matter.
See `examples/LOOPY_PLAN.md` for a starter template.

### Plan seed (`--plan`)
The plan seed is a raw problem statement. Loopy uses it to generate a PRD (`.loopy/PRD.md`) via the agent, then uses the PRD as the seed for the plan doc.

How to provide it:
- `--plan "<text>"`: inline text
- `--plan @<path>`: read text from a file (any extension; `.md` recommended)
- `--plan -`: read text from stdin

Notes:
- If you also provide `--prompt`, Loopy passes it as extra context during PRD generation.
- When run in a TTY, Loopy pauses for plan review after updating files.

### Seed prompt (`--prompt`)
The seed prompt is a PRD-style requirements/implementation notes document. Loopy uses it to generate or update the plan doc before looping, and it also includes the seed in `.loopy/PROMPT.md` for agent context.

How to provide it:
- `--prompt "<text>"`: inline text
- `--prompt @<path>`: read text from a file (any extension; `.md` recommended)
- `--prompt -`: read text from stdin

When it is used:
- If the plan doc does not exist, Loopy uses the seed prompt to generate it.
- If the plan doc exists and you provide a seed prompt, Loopy updates it automatically.
- If provided, Loopy includes the seed prompt in `.loopy/PROMPT.md` under `## Plan seed (PRD)`.
- Use `--confirm` to require confirmation before writing or applying plan updates.
- When run in a TTY, Loopy pauses for plan review after updating files.

### Phases (auto-phase)
Loopy supports phased execution via front matter:

```md
---
phase_defaults:
  stop_on: all_checked
  test_command: "npm test"
phases:
  - id: plan
    title: Plan
  - id: implement
    title: Implement
  - id: verify
    title: Verify
    stop_on: [all_checked, tests_pass]
    test_command: "npm test"
---
```

And a matching body structure:

```md
## Phase: plan
<!-- loopy:phase plan -->
- [ ] Clarify requirements and outline approach.

## Phase: implement
<!-- loopy:phase implement -->
- [ ] Implement the requested changes.

## Phase: verify
<!-- loopy:phase verify -->
- [ ] Run tests and validate behavior.
```

Notes:
- `stop_on` supports `all_checked` and `tests_pass`.
- `test_command` can be set per-phase; if present, Loopy runs it after a successful agent iteration.
- `--phase-only` stops once the current phase meets its `stop_on` criteria.
- Phase sections are detected via `<!-- loopy:phase <id> -->` (preferred) or `## Phase: <id>` headings.
- If phases are absent and `--auto-phase=false`, Loopy behaves like the legacy single-checklist flow.

Disable auto-phase and use the legacy single-checklist behavior:

```bash
loopy --auto-phase=false
```

### Global defaults (`~/.loopy/config.yml`)
You can set defaults that apply across repos:

```yaml
defaults:
  agent: "cursor-agent"
  stream: true
  verbose: true
  max_iterations: 20
  git:
    commit: true
```

Notes:
- You can place keys at the top level or under `defaults:`.
- Loopy persists a selected agent command here when you choose one interactively.

### Configuration and precedence
Loopy resolves settings from highest priority to lowest:

1. CLI flags (`loopy --...`)
2. Plan doc front matter (YAML in `--plan-file`, default `.loopy/LOOPY_PLAN.md`)
3. Global defaults (`~/.loopy/config.{yml,yaml,json}`)
4. Built-in defaults

Notes:
- `--agent` overrides `agent_command` in front matter.
- If `agent_command` is missing and Loopy is running in a TTY, it prompts you; otherwise it errors.
- `test_command` can be set globally, via `phase_defaults.test_command`, or per phase (phase-specific wins).

## CLI reference
For the latest full list, run `loopy --help`.

Core loop:
- `--agent <command>` agent command (overrides plan front matter)
- `--confirm` ask before writing or applying plan updates
- `--auto-phase` enable auto-phase planning (default: true; disable with `--auto-phase=false`)
- `--phase <id>` start/resume at phase id
- `--resume` resume from existing `.loopy/state.json`
- `--max-iterations <n>` max iterations (default: 50)
- `--max-minutes <n>` max wall time in minutes (default: 120)
- `--backoff-ms <n>` delay between iterations (default: 5000)
- `--dry-run` build prompt only, skip agent execution

Input/output paths:
- `--plan <text|@file|->` plan seed to generate PRD + plan before looping
- `--plan-file <file>` plan doc path (default: `.loopy/LOOPY_PLAN.md`)
- `--prompt <text|@file|->` seed prompt to generate/update the plan doc before looping

Output/utility:
- `--stream` mirror agent stdout/stderr to your terminal (default: true; disable with `--stream=false`)
- `--verbose` print full checklist details in the plan summary (default: true; disable with `--verbose=false`)
- `--version` print version and exit

### Less common flags

Core loop:
- `--phase-only` stop after current phase completes
- `--skip-phase <ids>` comma-separated phase ids to skip
- `--rotate-bytes <n>` byte threshold to force prompt rotation (default: 150000)

Input/output paths:
- `--prompt-out <file>` prompt output file (default: `.loopy/PROMPT.md`)
- `--progress <file>` progress file (default: `.loopy/progress.md`)
- `--guardrails <file>` guardrails file (default: `.loopy/guardrails.md`)
- `--activity-log <file>` activity log (default: `.loopy/activity.log`)
- `--state <file>` state file (default: `.loopy/state.json`)
- `--hints <file>` hints file (default: `.loopy/hints.md`)

Output/utility:
- `--no-color` disable ANSI colors (also honors `NO_COLOR`)
- `--no-emoji` disable emoji icons (ASCII fallback)
- `--plain` disable color and emoji

## Files created
- `.loopy/activity.log` append-only activity log
- `.loopy/progress.md` iteration status and test results
- `.loopy/guardrails.md` guardrails and failure signs
- `.loopy/state.json` internal state for gutter detection
- `.loopy/hints.md` append-only hints included in prompts
- `.loopy/last_agent_output.txt` most recent agent output (redacted)
- `.loopy/agent_stream.log` live agent stdout/stderr stream (redacted)
- `.loopy/last_test_output.txt` most recent test output (redacted)
- `.loopy/PROMPT.md` generated prompt input for each iteration
- `.loopy/PRD.md` generated PRD (when using `--plan`)

## Git integration
Loopy can:

- create/switch a branch before running (prompts by default when in a git repo)
- create/switch a worktree before running (then run the loop inside that worktree)
- commit changes after a successful iteration (default on; disable with `--git-commit=false`)

CLI flags:
```bash
loopy --git-branch "loopy/my-task"
loopy --git-worktree "../wt/loopy-my-task" --git-worktree-branch "loopy/my-task"
loopy --git-commit --git-commit-message "loopy: {change_type} {task_summary}"
```

Supported commit template variables:
- `{change_type}`: inferred from task line (prefix like `feat:` wins; otherwise agent-based classification with heuristic fallback)
- `{task_summary}`: first unchecked task line (falls back to first task item or first body line)
- `{iteration}`: iteration number (1-based)
- `{status}`: `success` / `failure` (commit only runs on success)
- `{test}`: test status string (e.g. `pass @ 2026-01-01T00:00:00.000Z`, or `n/a`)
- `{timestamp}`: ISO timestamp when committing
- `{taskComplete}`: `true` / `false`
- `{branch}`: current branch name (best-effort)

Plan front matter:
```md
---
agent_command: "cursor-agent"
test_command: "npm test"
git:
  worktree: "../wt/loopy-my-task"
  worktree_branch: "loopy/my-task"
  branch: "loopy/my-task"
  commit: true
  commit_message: "loopy: {change_type} {task_summary}"
---
```

Safety notes:
- Loopy never pushes to remotes.
- If `--git-worktree` is set without a branch, Loopy creates a detached HEAD worktree (`git worktree add --detach ...`).
- If you do not set `--git-branch` (or `git.branch` in the plan) and you are in a git repo, Loopy prompts for a branch name when starting a new loop.
- Non-interactive runs must pass `--git-branch` (or set `git.branch`) to avoid the branch prompt.
- If `--git-branch` is set, Loopy refuses to switch branches when there are uncommitted changes.
- With `--resume`, Loopy does not switch branches/worktrees (resume-only), so staged/dirty files will not block resuming.
- Auto-commit runs `git add -A` and then `git commit -m "<rendered message>"`.
- Git commits require an author/committer identity (via repo config or environment variables).

## Advanced configuration

### Seed prompt validation and normalization
- The seed prompt is read as UTF-8 text (BOM stripped if present).
- Line endings are normalized (CRLF/CR -> LF).
- Loopy trims only leading/trailing empty lines; internal whitespace is preserved.
- If the resulting content is empty, Loopy errors with a helpful message.
- If the path does not exist, is a directory, or is unreadable, Loopy errors.
- There is no explicit max size cap today; very large prompts can degrade planning quality.

## Troubleshooting
- Missing plan doc: provide `--prompt` or `--plan` to generate one (or use `--plan-file <file>` to point to an existing file).
- Agent exits immediately: verify `agent_command` is correct and accepts stdin.
- Loop stops early: check `.loopy/progress.md` and `.loopy/activity.log` for caps or completion.
- Guardrails growing: repeated failures or file thrashing were detected.
- Resume errors: `--resume` requires an existing plan file and `.loopy/state.json`; it also cannot be combined with `--prompt` or `--plan`.
- Flag errors: `--prompt` requires a value (`"<text>"`, `@<file>`, or `-`); `--prompt-out` requires a file path value.
- Resetting state: use `loopy reset` to archive all `.loopy/` files to `.loopy/archive/reset-<timestamp>/` for a clean start; or delete the whole `.loopy/` directory for a full reset.

## Notes
- Logs redact common secret patterns, but avoid writing secrets to stdout/stderr.
- The loop stops when all checkboxes in the plan doc (default: `.loopy/LOOPY_PLAN.md`) are checked.
- The loop also stops on "gutter" guardrails (repeated identical failures or file thrashing); see `.loopy/guardrails.md` and `.loopy/progress.md`.
