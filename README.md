# 🔄 Loopy

> **A lightweight Node.js CLI for running Ralph-style coding agent loops with durable state, guardrails, and logs.**

Loopy wraps any agent CLI that reads prompts from standard input and adds:
- ✅ Predictable iteration control
- ✅ Failure protection and recovery
- ✅ Clear visibility into agent actions
- ✅ Durable state across runs

**Transform fragile single-run agent executions into controlled, repeatable loops.**

---

## 🎯 When to Use Loopy

Use Loopy when you want to run a coding agent repeatedly on non-trivial tasks while maintaining progress, safety, and visibility across iterations.

### What Loopy Does NOT Do
- ❌ Does not manage credentials
- ❌ Does not push to git remotes  
- ❌ Does not replace agent tools — only orchestrates them

## 🚀 Quickstart

### Installation

```bash
npm install
npm link
```

**Requirements:**
- Node.js 18+
- A git repository
- An agent CLI that accepts prompts via stdin

### Run Your First Loop

**Just run `loopy` — that's it!** No configuration needed upfront.

```bash
loopy
```

The tool will interactively guide you through:
1. 🤖 **Select or enter your agent command** (e.g., `cursor-agent`, `copilot`)
2. 📝 **Enter your task or plan description** (what you want to build/fix)
3. 🌿 **Choose a git branch** (optional)

Everything will be requested as you go — no config files required!

**Advanced: Provide everything via flags**
```bash
loopy --agent "cursor-agent" --prompt "Add OAuth login to the app" --git-branch "loopy/oauth-login"
```

## 📖 Common Workflows

### Start a New Loop
```bash
loopy --agent "cursor-agent" --prompt "Add OAuth login to the app"
```

### Resume a Previous Run
```bash
loopy --resume
```
> **Note:** Requires `.loopy/state.json`. Cannot be combined with `--prompt` or `--plan`.

### Run a Single Iteration
```bash
loopy --max-iterations 1 --agent "cursor-agent"
```

### Check Status
```bash
loopy status
```
**Status displays:** iteration, current phase, last status, last test, last error, last hint + hint count, last bytes, updated timestamp.

> More workflows and input examples available in [`docs/REFERENCE.md`](./docs/REFERENCE.md)

## 🧠 Mental Model

Loopy treats a **markdown plan document** as the source of truth:

1. 📄 Each iteration reads the plan document
2. 🤖 Runs the agent
3. 🛡️ Applies guardrails
4. 💾 Updates state

**Completion is driven by checked items, not by agent confidence.**

---

## 📚 Documentation & Examples

- **[Complete Reference](./docs/REFERENCE.md)** — Full CLI reference, core concepts, git integration, and troubleshooting
- **[Examples](./examples)** — Sample PRDs, prompts, and plan document templates

---

## 📄 License

MIT