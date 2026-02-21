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
- Prompt context is assembled from plan/task state and explicit PRD references; no implicit AGENTS/spec injection.

## Judge Scaffold Flow

```text
loopy add-judge
  -> src/cli.js
     -> src/scaffold.js
        -> src/lib/llm-review.js (fixture)
        -> src/lib/llm-review.test.js (examples)
```

Notes:
- The scaffold is created in the target project, not in Loopy itself.
