# Prompt seed examples (`--prompt`)

All `--prompt` forms generate/update the plan doc once **before** the loop starts.

```bash
# Inline
loopy loop --dry-run --prompt "Build a thing" --agent "cursor-agent"

# File
loopy loop --dry-run --prompt @./PRD.md --agent "cursor-agent"

# Stdin
cat ./PRD.md | loopy loop --dry-run --prompt - --agent "cursor-agent"
```

Add `--confirm` if you want a prompt before writing plan updates.

