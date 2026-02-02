<div align="center">

# 🔄 Loopy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![npm version](https://img.shields.io/npm/v/loopy.svg)](https://www.npmjs.com/package/loopy)

**A lightweight Node.js CLI for running Ralph-style coding agent loops with durable state, guardrails, and logs.**

Transform fragile single-run agent executions into controlled, repeatable loops.

[Quick Start](#-quick-start) •
[Key Features](#-key-features) •
[Documentation](./docs/REFERENCE.md) •
[Examples](./examples)

</div>

---

## 📋 Table of Contents

- [Why Loopy?](#-why-loopy)
- [Key Features](#-key-features)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Common Workflows](#-common-workflows)
- [How It Works](#-how-it-works)
- [Documentation & Examples](#-documentation--examples)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🤔 Why Loopy?

Running coding agents on complex tasks can be unpredictable. They might stop mid-task, fail unexpectedly, or lose track of progress. Loopy solves this by wrapping any agent CLI and providing:

- 🔁 **Automatic iteration control** — Run your agent repeatedly until the task is complete
- 💾 **Durable state management** — Never lose progress, resume anytime
- 🛡️ **Built-in guardrails** — Detect and prevent infinite loops, drift, and errors
- 📊 **Complete visibility** — Full logs, status tracking, and progress monitoring
- 🌿 **Git integration** — Automatic branching and commits with meaningful messages

**Perfect for:** Feature development, refactoring, bug fixes, test writing, and any multi-step coding task that benefits from agent persistence.

---

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| **Zero-Config Start** | Run `loopy` and answer prompts — no setup files required |
| **Plan-Driven Execution** | Track progress with markdown checklists |
| **Failure Recovery** | Resume from where you left off, even after crashes |
| **Phase Management** | Organize work into plan → implement → verify phases |
| **Smart Rotation** | Automatically rotate context to prevent token bloat |
| **Test Integration** | Run tests between iterations to validate progress |
| **Git Automation** | Auto-commit with semantic messages, branch management |
| **Agent Agnostic** | Works with any CLI that accepts stdin prompts |

---

## 📦 Installation

### Install from npm (Recommended)

```bash
npm install -g loopy
```

### Install from source

```bash
git clone https://github.com/yourusername/loopy.git
cd loopy
npm install
npm link
```

**Requirements:**
- Node.js 18+
- A git repository (for your project)
- An agent CLI that accepts prompts via stdin (e.g., `cursor-agent`, `copilot`)

---

## 🚀 Quick Start

### Your First Loop

**Just run `loopy` — that's it!** No configuration files needed upfront.

```bash
loopy
```

Defaults to build mode: Loopy follows tasks in `LOOPY_PLAN.md` and updates checkboxes as work completes.

Loopy also includes `AGENTS.md` and a `specs/` summary in each prompt. If `AGENTS.md` is missing, it bootstraps `.loopy/AGENTS.md` unless `--no-bootstrap-agents` is set.

Loopy will interactively guide you through:
1. 🤖 **Agent command** — Select or enter your agent CLI (e.g., `cursor-agent`, `copilot --allow-all`)
2. 📝 **Task description** — Describe what you want to build or fix
3. 🌿 **Git branch** — Choose a branch name (optional but recommended)

That's all you need to get started!

### Advanced: Skip the Prompts

Provide everything via command-line flags for automation or scripting:

```bash
loopy \
  --agent "copilot --allow-all" \
  --prompt "Add authentication middleware with JWT support" \
  --git-branch "loopy/add-auth"
```

## 📖 Common Workflows

### Start a New Task

```bash
# Feature development
loopy --agent "copilot --allow-all" \
      --prompt "Add OAuth2 authentication with Google provider"

# Bug fix
loopy --agent "cursor-agent" \
      --prompt "Fix memory leak in the WebSocket handler"

# Refactoring
loopy --agent "copilot" \
      --prompt "Convert all class components to functional components with hooks"
```

### Resume After Interruption

```bash
loopy --resume
```

> Picks up exactly where you left off using `.loopy/state.json`. Perfect for continuing after crashes, breaks, or manual stops.

### Run Limited Iterations

```bash
# Test with a single iteration
loopy --max-iterations 1

# Run 5 iterations then pause
loopy --max-iterations 5 --resume
```

### Monitor Progress

```bash
loopy status
```

Displays: iteration count, current phase, last status, test results, errors, output size, and timestamps.

### Use a Predefined PRD

```bash
loopy --prd examples/feature-prd.md
```

Use the PRD-first flow to generate/update `LOOPY_PLAN.md` from a PRD seed.

If you already have a clear plan seed, use `--prompt` instead of `--prd`.

### Plan-Only Mode

```bash
loopy --mode plan --prompt "Add OAuth login to the app"
```

Generates/updates `LOOPY_PLAN.md` and exits without running build iterations.

### Prompt Templates

Add `PROMPT_build.md` and `PROMPT_plan.md` to customize prompts per mode. Use `--prompt-template <file>` to override the template path.

> 📚 More workflows in [`docs/REFERENCE.md`](./docs/REFERENCE.md) and Ralph-specific guidance in [`docs/RALPH_WORKFLOW.md`](./docs/RALPH_WORKFLOW.md). Templates live in [`examples/`](./examples).

---

## 🧠 How It Works

Loopy treats a **markdown plan document** as the source of truth and orchestrates your agent through structured iterations:

```
┌─────────────────────────────────────────┐
│  1. Read Plan (LOOPY_PLAN.md)           │
│     ↓                                   │
│  2. Prepare Agent Prompt                │
│     ↓                                   │
│  3. Execute Agent CLI                   │
│     ↓                                   │
│  4. Capture Output & State              │
│     ↓                                   │
│  5. Apply Guardrails                    │
│     ↓                                   │
│  6. Update Plan & State                 │
│     ↓                                   │
│  7. Commit Changes (if enabled)         │
│     ↓                                   │
│  8. Check Completion → Loop or Exit     │
└─────────────────────────────────────────┘
```

### Key Principles

- **Plan-Driven**: Progress is tracked via markdown checkboxes `- [ ]` → `- [x]`
- **Stateful**: Every iteration updates `.loopy/state.json` with progress, errors, and metrics
- **Recoverable**: Crashes or interruptions don't lose progress — just `--resume`
- **Observable**: Full logs in `.loopy/history/` for every iteration
- **Controlled**: Guardrails detect loops, drift, and repetitive errors automatically

**Completion criteria:** All checkboxes in the current phase are checked, or max iterations reached.

---

## 📚 Documentation & Examples

| Resource | Description |
|----------|-------------|
| **[Complete Reference](./docs/REFERENCE.md)** | Full CLI reference, configuration options, git integration, and troubleshooting |
| **[Architecture](./docs/ARCHITECTURE.md)** | Lightweight module diagram and system map |
| **[Ralph Workflow](./docs/RALPH_WORKFLOW.md)** | Planning vs building guidance, templates, and workflow conventions |
| **[Examples](./examples)** | Sample PRDs, prompts, and plan templates for common use cases |

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Report bugs** — Open an issue with details and reproduction steps
2. **Suggest features** — Share your ideas for improvements
3. **Submit PRs** — Fix bugs or add features (please open an issue first for major changes)

### Development Setup

```bash
git clone https://github.com/yourusername/loopy.git
cd loopy
npm install
npm link
npm test
```

### Guidelines

- Follow existing code style
- Add tests for new features
- Update documentation for user-facing changes
- Keep commits focused and descriptive

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) for details.

Copyright (c) 2026 Vagner Santana
