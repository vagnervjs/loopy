# Architecture Diagram

```text
                         +----------------------+
                         |      bin/loopy.js    |
                         +----------+-----------+
                                    |
                                    v
                         +----------------------+
                         |       src/cli.js     |
                         +----------+-----------+
                                    |
                                    v
                         +----------------------+
                         |      src/loop.js     |
                         +----------+-----------+
                                    |
        +---------------------------+---------------------------+
        |            |              |             |             |
        v            v              v             v             v
  loop/iteration  loop/plan-ensure  loop/seed  loop/phases  loop/archive
        |            |              |             |             |
        v            v              v             v             v
  prompt/guardrails  agents-doc   stdin/files  phase rules   archive move

Shared utilities:
  - config + config-validate
  - task, prompt, guardrails, text
  - git, shell, fs, state, steps

Artifacts (.loopy/):
  - PROMPT.md, LOOPY_PLAN.md, state.json, progress.md, guardrails.md
  - history/activity logs, last_agent_output.txt, last_test_output.txt
```

Notes:
- `src/loop/plan-overview.js` and `src/loop/prompt-templates.js` are used by the loop orchestrator for summaries and template selection.
- `src/loop/agents-doc.js` builds/loads `AGENTS.md` for prompt context.
