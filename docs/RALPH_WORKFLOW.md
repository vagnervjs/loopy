# Ralph Workflow Changes (Phase 1)

This document summarizes the Phase 1 updates for Ralph-compatible planning/prompt infrastructure and explains how to use the new workflows.

## Main changes

- Added `--mode` to control plan-only vs build runs (`build` is the default).
- Added prompt template discovery using `PROMPT_build.md` and `PROMPT_plan.md`.
- Added `--prompt-template <file>` to override the template file path.
- Plan-only mode now prepares the plan and writes a prompt preview without running build iterations.
- Loopy now includes `AGENTS.md` and a `specs/` summary in prompts (auto-generates `.loopy/AGENTS.md` when missing).

## New workflow options

### 1) Build mode (default)

Build mode behaves like the previous Loopy flow: plan prep (if needed) followed by iterative agent runs.

```bash
loopy --mode build
```

In build mode, Loopy reads tasks from `LOOPY_PLAN.md`, follows the checklist for the current task, and updates progress/checkboxes as work completes.

If `PROMPT_build.md` exists, it is used as the prompt template for iterations.

### 2) Plan-only mode

Plan-only mode generates or updates the plan, writes a prompt preview, and exits without running any build iterations.

```bash
loopy --mode plan --prompt "Add OAuth2 login flow"
```

In plan mode, Loopy generates or updates `LOOPY_PLAN.md` and stops after writing the prompt preview.

If `PROMPT_plan.md` exists, it is used as the prompt template for the preview.

## Prompt templates

Loopy will look for a prompt template in this order:

1) `--prompt-template <file>` (explicit override)
2) `PROMPT_build.md` or `PROMPT_plan.md` in the repo root (based on mode)
3) `PROMPT_build.md` or `PROMPT_plan.md` inside `.loopy/`

If no template is found, Loopy falls back to the built-in prompt format.

Loopy also injects `AGENTS.md` content and a `specs/` summary into every prompt (when available). If no repo-level `AGENTS.md` exists, it will bootstrap `.loopy/AGENTS.md` unless you pass `--no-bootstrap-agents`.

### Template placeholders

Use these placeholders in your template to inject Loopy context:

- `{{timestamp}}`
- `{{iteration}}`
- `{{rotation}}`
- `{{rotation_pending}}`
- `{{phase}}`
- `{{plan_label}}`
- `{{plan}}`
- `{{seed_label}}`
- `{{seed}}`
- `{{seed_block}}`
- `{{hints}}`
- `{{hints_block}}`
- `{{current_task}}`
- `{{current_task_block}}`
- `{{guardrails}}`
- `{{progress}}`
- `{{last_output}}`
- `{{last_output_block}}`
- `{{instructions}}`

Placeholders that are not available resolve to an empty string.

### Minimal example

```markdown
# Custom Prompt

Timestamp: {{timestamp}}
Iteration: {{iteration}}

{{current_task_block}}

## Plan
{{plan}}

{{instructions}}
```
