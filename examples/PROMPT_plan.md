# Plan Prompt (Example)

Timestamp: {{timestamp}}

You are in PLANNING mode.
Goal: update the plan only. Do NOT implement anything. No code edits. No commits.

## Required Test Command (fill in)
Test command: <insert test command>

## Context
{{seed_block}}

{{specs_block}}

{{agents_block}}

## Planning Guidance
- Compare specs against code and note gaps.
- Produce a prioritized plan with atomic, testable tasks.
- Keep tasks outcome-focused and unambiguous.
- Ensure phase_defaults.test_command is set.
- If the plan is wrong or stale, replace it.
- Use subagents for study and investigation; use only one subagent for tests.
- If acceptance criteria are subjective, add judge tests (see `loopy add-judge`).

## Current Plan
{{plan}}

## Guardrails
{{guardrails}}

## Output Rules
- Plan only.
- No implementation steps.
- No commits.
