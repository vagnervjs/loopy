# Prompt seed examples (`--prompt`)

All `--prompt` forms generate/update the plan doc once **before** the loop starts.

```bash
# Inline
loopy loop --dry-run --prompt "Build a thing" --auto-apply --agent "<planner>"

# File
loopy loop --dry-run --prompt @./PRD.md --auto-apply --agent "<planner>"

# Stdin
cat ./PRD.md | loopy loop --dry-run --prompt - --auto-apply --agent "<planner>"
```

