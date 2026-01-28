# Prompt seed examples (`--prompt`)

## Interactive mode
Just run `loopy` without flags and it will prompt you for:
- Agent command
- Plan/task description
- Git branch (optional)

```bash
loopy
```

## Non-interactive mode
All `--prompt` forms generate/update the plan doc once **before** the loop starts.

```bash
# Inline
loopy --dry-run --prompt "Build a thing" --agent "cursor-agent"

# File
loopy --dry-run --prompt @./PRD.md --agent "cursor-agent"

# Stdin
cat ./PRD.md | loopy --dry-run --prompt - --agent "cursor-agent"
```

Add `--confirm` if you want a prompt before writing plan updates.
