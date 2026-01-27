---
agent_command: "cursor-agent"
test_command: "npm test"
max_iterations: 10
max_minutes: 60
backoff_ms: 5000
rotate_bytes: 150000
git:
  branch: "loopy/auto-phase"
  commit: true
  commit_message: "loopy: {change_type} {task_summary}"
---
# Task

- [x] feat: Add CLI prompt input to generate/update `LOOPY_TASK.md` before looping.
- [x] feat: Enable auto-phase by default; use configured agent to propose phases from task text.
- [x] feat: Define and parse phase schema in front matter (`phases`, `phase_defaults`).
- [x] feat: Scope checklist evaluation to current phase sections.
- [x] feat: Support per-phase `stop_on` and optional `test_command`.
- [x] feat: Track `currentPhase` and phase history in `.loopy/state.json` and progress output.
- [x] feat: Add CLI flags `--phase`, `--phase-only`, `--skip-phase`, `--auto-phase`.
- [x] feat: Add confirmation step before rewriting `LOOPY_TASK.md`, with auto-apply mode.
- [x] feat: Ensure backward compatibility when phases are absent and auto-phase is disabled.
- [x] docs: Update README with auto-phase quickstart and phase schema reference.
- [x] test: Add coverage for auto-phase generation, confirmation flow, and phase progression.
