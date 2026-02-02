# Build Prompt (Example)

Timestamp: {{timestamp}}
Iteration: {{iteration}}

You are in BUILDING mode.
Goal: complete exactly one task from the current plan.

## Required Test Command (fill in)
Test command: <insert test command>

## Context
{{seed_block}}

{{specs_block}}

{{agents_block}}

{{current_task_block}}

## Plan
{{plan}}

## Guardrails
{{guardrails}}

## Task Rules
- Do not assume functionality is missing; search first.
- Complete only the current task.
- Implement fully; no stubs or placeholders.
- Run the required tests for the phase and fix failures.
- Update the plan checkbox for the completed task.

{{instructions}}
