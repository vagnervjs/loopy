# Loopy

Loopy is a lightweight Node.js CLI for running Ralph-style coding agent loops with durable state, guardrails, and logs.

It wraps any agent CLI that reads prompts from standard input and adds predictable iteration, failure protection, and clear visibility into what the agent is doing.

It turns fragile single run agent executions into a controlled, repeatable loop.

Use Loopy when you want to run a coding agent repeatedly on a non-trivial task and keep progress, safety, and visibility across iterations.

## What Loopy does not do
- Does not manage credentials
- Does not push to git remotes
- Does not replace agent tools, only orchestrates them

## Quickstart

### Run your first loop

**🚀 Just run `loopy` — that's it!**

No configuration needed upfront. Simply run:

```bash
loopy
```

The tool will interactively guide you through setup, prompting you to:
1. **Select or enter your agent command** (e.g., "cursor-agent", "copilot")
2. **Enter your task or plan description** (what you want to build/fix)
3. **Choose a git branch** (optional)

Everything you need will be requested as you go — no config files required to get started!

**Advanced users: provide everything via flags:**
```bash
loopy --agent "cursor-agent" --prompt "Add OAuth login to the app" --git-branch "loopy/oauth-login"
```

If `loopy` isn't on your PATH yet, install it below.

### Install
```bash
npm install
npm link
```

### Requirements
- Node.js 18+
- A git repo
- An agent CLI that accepts prompt input via stdin

## Common workflows

**Start a new loop (non-interactive):**
```bash
loopy --agent "cursor-agent" --prompt "Add OAuth login to the app"
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

More workflows and input examples live in `docs/REFERENCE.md`.

## Mental model
Loopy treats a markdown plan doc as the source of truth.
Each iteration reads the plan doc, runs the agent, applies guardrails, and updates state.
Completion is driven by checked items, not by agent confidence.

## Full reference and examples
See [`docs/REFERENCE.md`](./docs/REFERENCE.md) for the complete CLI reference, core concepts, git integration, and troubleshooting.

Browse the [`examples`](./examples) folder for sample PRDs, prompts, and plan document templates.