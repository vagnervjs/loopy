# Loopy

Loopy is a Node.js CLI that runs a Ralph-style coding agent loop with durable state, guardrails, and logs.

## Requirements

- Node.js 18+
- A git repo (recommended)
- An agent CLI that accepts prompt input via stdin

## Setup

```bash
npm install
```

Optional: install the `loopy` binary on your PATH:

```bash
npm link
```

Or run from the repo without linking:

```bash
node bin/loopy.js --help
```

## Usage

### Auto-phase quickstart (recommended)

Generate or update `.loopy/LOOPY_PLAN.md` from a simple prompt, then start looping:

```bash
loopy loop --agent "cursor-agent" --prompt "Add OAuth login to the app" --auto-apply
```

Or read the prompt from a file (or stdin via `-`):

```bash
loopy loop --agent "cursor-agent" --prompt @./task.txt --auto-apply
```

Or via stdin:

```bash
cat ./task.txt | loopy loop --agent "cursor-agent" --prompt - --auto-apply
```

Tip: `loop` is the default command, so `loopy [options]` is equivalent to `loopy loop [options]`.

Migration note:

- Default generated file locations are under `.loopy/` (plan: `.loopy/LOOPY_PLAN.md`, prompt: `.loopy/PROMPT.md`).
- Legacy flags/commands are not accepted; use `loopy --help` to update any scripts.

By default, Loopy will try to auto-phase (create `phases` + per-phase checklists) when a plan file has no phases.
To disable auto-phase and use the legacy “single checklist” behavior:

```bash
loopy loop --auto-phase=false
```

Initialize a new workspace (scaffolds `.loopy/`, `.loopy/hints.md`, and `.loopy/LOOPY_PLAN.md`):

```bash
loopy init
```

Add a mid-loop hint (included in the next generated `.loopy/PROMPT.md`):

```bash
loopy hint "Focus on fixing the failing test first."
```

Remove the last hint (pop):

```bash
loopy hint --pop
```

Clear all hints (reset):

```bash
loopy hint --reset
```

Show help:

```bash
loopy help
# or: node bin/loopy.js --help
```

Show version:

```bash
loopy --version
# or: node bin/loopy.js --version
```

Show last run status (from `.loopy/state.json`):

```bash
loopy status
# or: node bin/loopy.js status
```

Single iteration:

```bash
loopy loop --max-iterations 1 --agent "cursor-agent"
# or: node bin/loopy.js loop --max-iterations 1 --agent "cursor-agent"
```

Loop until completion/caps:

```bash
loopy loop --agent "cursor-agent"
# or: node bin/loopy.js loop --agent "cursor-agent"
```

Resume a previous run (requires an existing plan + `.loopy/state.json`; works even with staged files):

```bash
loopy loop --continue
```

Note: `--continue` is resume-only and **cannot** be combined with `--prompt`.

### End-to-end example (PRD → plan → loop)

```bash
# One-time setup (creates `.loopy/LOOPY_PLAN.md` + `.loopy/hints.md` if missing)
loopy init

# Start looping (reads the PRD, proposes/updates the plan, then runs iterations)
loopy loop --agent "cursor-agent" --prompt @examples/PRD.md --auto-apply --stream

# Inspect status any time
loopy status

# If interrupted, resume later
loopy loop --continue
```

### Plan doc (`--plan`, default `.loopy/LOOPY_PLAN.md`)

Loopy’s **plan doc** is the durable source of truth the loop reads on every iteration. It contains:

- YAML front matter (agent command, test command, loop limits, git settings, phases)
- The checklist(s) that represent progress and completion

By default this file is `.loopy/LOOPY_PLAN.md`, but you can point Loopy at any path via `--plan <file>`.

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

### Seed prompt (`--prompt`)

The **seed prompt** is a PRD-style requirements/implementation notes document. Loopy uses it to generate/update the plan doc (usually `.loopy/LOOPY_PLAN.md`) before looping, and also includes it in the per-iteration prompt for clarity. **Seed source does not change behavior**: inline text, `@file`, and stdin (`-`) all follow the same pre-loop plan generate/update step.

Where it’s used:

- If the plan doc does not exist, Loopy uses the seed prompt to generate it.
- If the plan doc exists and you provide a seed prompt, Loopy updates it automatically.
- If provided, Loopy includes the seed prompt in `.loopy/PROMPT.md` under `## Plan seed (PRD)` so the agent can reference the original requirements verbatim.

How to provide it:

- `--prompt "<text>"`: inline text.
- `--prompt @<path>`: read text from a file (any extension; `.md` recommended).
- `--prompt -`: read text from stdin.
Validation / normalization (current behavior):

- The seed prompt is read as **UTF-8 text** (BOM stripped if present).
- Line endings are normalized (CRLF/CR → LF).
- Loopy trims only leading/trailing *empty lines* (internal whitespace/newlines are preserved).
- If the resulting content is empty, Loopy errors (stdin: “Seed prompt from --prompt '-' (stdin) is empty.”; file: “Seed prompt file is empty: ...”).
- If the file path does not exist, Loopy errors (“Seed prompt file not found: ...”).
- If the path is a directory, Loopy errors (“Seed prompt path is a directory: ...”).
- If the file is unreadable due to permissions, Loopy errors (“Permission denied reading seed prompt file: ...”).
- There is no explicit max size cap today; very large seed prompts can degrade planning quality and make updates noisy.

### Phase schema (auto-phase)

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
- Phase sections are detected via `<!-- loopy:phase <id> -->` (preferred) or `## Phase: <id>` headings; checklists are evaluated **within** each phase section.
- If phases are absent and `--auto-phase=false`, Loopy behaves like the legacy single-checklist flow.

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

## Options

- `--version` print version and exit
- `--plan <file>` plan doc path (default: `.loopy/LOOPY_PLAN.md`)
- `--prompt <text|@file|->` seed prompt to generate/update the plan doc before looping
- `--continue` resume from existing `.loopy/state.json` (requires an existing plan + state; skips git switching so staged files don't block; cannot be used with `--prompt`)
- `--prompt-out <file>` prompt output file (default: `.loopy/PROMPT.md`)
- `--progress <file>` progress file (default: `.loopy/progress.md`)
- `--guardrails <file>` guardrails file (default: `.loopy/guardrails.md`)
- `--activity-log <file>` activity log (default: `.loopy/activity.log`)
- `--state <file>` state file (default: `.loopy/state.json`)
- `--hints <file>` hints file (default: `.loopy/hints.md`)
- `--agent <command>` agent command (overrides plan front matter)
- `--auto-phase` enable auto-phase planning (default: true; disable with `--auto-phase=false`)
- `--phase <id>` start/resume at phase id
- `--phase-only` stop after current phase completes
- `--skip-phase <ids>` comma-separated phase ids to skip
- `--auto-apply` skip confirmation prompts (apply changes)
- `--stream` mirror agent stdout/stderr to your terminal
- `--max-iterations <n>` max iterations (default: 50)
- `--max-minutes <n>` max wall time in minutes (default: 120)
- `--backoff-ms <n>` delay between iterations (default: 5000)
- `--rotate-bytes <n>` byte threshold to force prompt rotation (default: 150000)
- `--dry-run` build prompt only, skip agent execution (stops after the first prompt build)

## Configuration and precedence

Loopy resolves settings from (highest priority first):

1. CLI flags (`loopy loop --...`)
2. Plan doc front matter (YAML in `--plan`, default `.loopy/LOOPY_PLAN.md`)
3. Built-in defaults

Notes:

- `--agent` overrides `agent_command` in the plan front matter.
- If `agent_command` is missing and Loopy is running in a TTY, it will prompt you to enter it; otherwise it errors.
- `test_command` can be set globally in front matter, via `phase_defaults.test_command`, and/or per phase via `phases[].test_command` (phase-specific wins).

## Streaming agent output

Loopy always writes the agent's stdout/stderr to `.loopy/agent_stream.log` as it runs.

Loopy also prints short **step status** lines to the terminal (iteration start, hooks, agent run, tests, git, state updates).

To also mirror the agent output to your terminal, pass `--stream`:

```bash
loopy loop --agent "cursor-agent" --stream
```

## Status command

`loopy status` reads `.loopy/state.json` and prints a short summary:

- iteration
- current phase
- last status
- last test
- last error
- last hint + hint count
- last bytes
- updated at

If `.loopy/state.json` is missing or invalid, it prints a friendly error and exits with code 1.

## Git integration (optional)

Loopy can optionally:

- create/switch a branch before running
- create/switch a worktree before running (then run the loop *inside* that worktree)
- commit changes after a **successful** iteration

### CLI flags

Create/switch a branch before the first iteration:

```bash
loopy loop --git-branch "loopy/my-task"
```

Run inside a worktree (creates it if missing):

```bash
loopy loop --git-worktree "../wt/loopy-my-task" --git-worktree-branch "loopy/my-task"
```

Auto-commit after successful iterations (with a template):

```bash
loopy loop --git-commit --git-commit-message "loopy: {change_type} {task_summary}"
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

### Plan front matter

You can also configure git via the plan doc front matter (default: `.loopy/LOOPY_PLAN.md`):

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

### Safety notes

- Loopy **never pushes** to remotes.
- If `--git-worktree` is set without a branch, Loopy creates a **detached HEAD** worktree (`git worktree add --detach ...`).
- If you don’t set `--git-branch` (or `git.branch` in the plan) and you’re in a git repo, Loopy will synthesize a default `loopy/<slug>` branch (based on the seed prompt or the current directory) unless you explicitly set `--git-worktree-branch`.
- If `--git-branch` is set, Loopy refuses to switch branches when there are **uncommitted changes**.
- With `--continue`, Loopy **does not** switch branches/worktrees (resume-only), so staged/dirty files won't block resuming.
- Auto-commit runs `git add -A` and then `git commit -m "<rendered message>"`.
- Git commits require an author/committer identity (via repo config or environment variables).

## Troubleshooting

- Missing plan doc: run `loopy init` or provide `--prompt` (or use `--plan <file>` to point Loopy at your plan doc).
- Agent exits immediately: verify `agent_command` is correct and accepts stdin.
- Loop stops early: check `.loopy/progress.md` and `.loopy/activity.log` for caps or completion.
- Guardrails growing: repeated failures or file thrashing were detected.
- Resume errors: `--continue` requires an existing plan file and `.loopy/state.json`; it also cannot be combined with `--prompt`.
- Flag errors: `--prompt` requires a value (`"<text>"`, `@<file>`, or `-`); `--prompt-out` requires a file path value.
- Resetting state: delete `.loopy/state.json` (and optionally `.loopy/progress.md`) to force a fresh run; delete the whole `.loopy/` directory for a full reset.

## Notes

- Logs redact common secret patterns, but avoid writing secrets to stdout/stderr.
- The loop stops when all checkboxes in the plan doc (default: `.loopy/LOOPY_PLAN.md`) are checked.
- The loop also stops on “gutter” guardrails (repeated identical failures or file thrashing); see `.loopy/guardrails.md` and `.loopy/progress.md`.
