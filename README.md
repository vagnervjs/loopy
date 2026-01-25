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

## Usage

Show help:

```bash
loopy help
# or: node bin/loopy.js --help
```

Single iteration:

```bash
loopy run --agent-cmd "cursor-agent"
# or: node bin/loopy.js run --agent-cmd "cursor-agent"
```

Loop until completion/caps:

```bash
loopy loop --agent-cmd "cursor-agent"
# or: node bin/loopy.js loop --agent-cmd "cursor-agent"
```

### Task file

Create `RALPH_TASK.md` in the repo root. Example:

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

# Task

- [ ] Add a CLI help command.
- [ ] Implement loop guardrails.
- [ ] Update README with usage instructions.
```

You can also pass `--agent-cmd` to override the task front matter.
See `examples/RALPH_TASK.md` for a starter template.

## Files created

- `.ralph/activity.log` append-only activity log
- `.ralph/progress.md` iteration status and test results
- `.ralph/guardrails.md` guardrails and failure signs
- `.ralph/state.json` internal state for gutter detection
- `.ralph/last_agent_output.txt` most recent agent output (redacted)
- `.ralph/last_test_output.txt` most recent test output (redacted)
- `PROMPT.md` generated prompt input for each iteration

## Options

- `--task <file>` task file path (default: `RALPH_TASK.md`)
- `--prompt <file>` prompt output file (default: `PROMPT.md`)
- `--progress <file>` progress file (default: `.ralph/progress.md`)
- `--guardrails <file>` guardrails file (default: `.ralph/guardrails.md`)
- `--activity-log <file>` activity log (default: `.ralph/activity.log`)
- `--state <file>` state file (default: `.ralph/state.json`)
- `--agent-cmd <command>` agent command (overrides task front matter)
- `--max-iterations <n>` max iterations (default: 50)
- `--max-minutes <n>` max wall time in minutes (default: 120)
- `--backoff-ms <n>` delay between iterations (default: 5000)
- `--rotate-bytes <n>` byte threshold to force prompt rotation (default: 150000)
- `--dry-run` build prompt only, skip agent execution

## Git integration (optional)

Loopy can optionally:

- create/switch a branch before running
- create/switch a worktree before running (then run the loop *inside* that worktree)
- commit changes after a **successful** iteration

### CLI flags

Create/switch a branch before the first iteration:

```bash
loopy loop --git-branch "ralph/my-task"
```

Run inside a worktree (creates it if missing):

```bash
loopy loop --git-worktree "../wt/ralph-my-task" --git-worktree-branch "ralph/my-task"
```

Auto-commit after successful iterations (with a template):

```bash
loopy loop --git-commit --git-commit-message "Loopy {iteration}: {status} ({test})"
```

Supported commit template variables:

- `{iteration}`: iteration number (1-based)
- `{status}`: `success` / `failure` (commit only runs on success)
- `{test}`: test status string (e.g. `pass @ 2026-01-01T00:00:00.000Z`, or `n/a`)
- `{timestamp}`: ISO timestamp when committing
- `{taskComplete}`: `true` / `false`
- `{branch}`: current branch name (best-effort)

### Task front matter

You can also configure git via `RALPH_TASK.md` front matter:

```md
---
agent_command: "cursor-agent"
test_command: "npm test"
git:
  worktree: "../wt/ralph-my-task"
  worktree_branch: "ralph/my-task"
  branch: "ralph/my-task"
  commit: true
  commit_message: "Loopy {iteration}: {status} ({test})"
---
```

### Safety notes

- Loopy **never pushes** to remotes.
- If `--git-worktree` is set without a branch, Loopy creates a **detached HEAD** worktree (`git worktree add --detach ...`).
- If `--git-branch` is set, Loopy refuses to switch branches when there are **uncommitted changes**.
- Auto-commit runs `git add -A` and then `git commit -m "<rendered message>"`.
- Git commits require an author/committer identity (via repo config or environment variables).

## Troubleshooting

- Missing `RALPH_TASK.md`: create the file and include at least one checklist item.
- Agent exits immediately: verify `agent_command` is correct and accepts stdin.
- Loop stops early: check `.ralph/progress.md` and `.ralph/activity.log` for caps or completion.
- Guardrails growing: repeated failures or file thrashing were detected.

## Notes

- Logs redact common secret patterns, but avoid writing secrets to stdout/stderr.
- The loop stops when all checkboxes in `RALPH_TASK.md` are checked.
- The loop also stops on “gutter” guardrails (repeated identical failures or file thrashing); see `.ralph/guardrails.md` and `.ralph/progress.md`.
