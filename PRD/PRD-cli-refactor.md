Plan: CLI Simplification + Refactor

  1. Define the target UX (minimal commands first)
      - loopy loop --prompt "..." (default auto‑phase + generate/update `.loopy/LOOPY_PLAN.md`)
      - --prompt accepts inline text or a file reference (e.g., --prompt @path/to/prompt.md)
      - loopy status (iteration, phase, last error, hints)
      - loopy hint "..." (mid‑loop context injection)
      - loopy init (scaffold `.loopy/LOOPY_PLAN.md` + `.loopy/` + example)
      - Advanced flags (--phase, --phase-only, --skip-phase, --auto-phase) go under an “Advanced” section in help.
      - No subcommand defaults to loop, and this is documented in help.
  2. Refactor CLI surface + remove redundancy
      - Consolidate around loop as the primary path.
      - Standardize prompt ingestion: inline --prompt or @file to generate/update `.loopy/LOOPY_PLAN.md`.
      - Remove or simplify flags that duplicate the new commands.
  3. Refactor core implementation for clarity
      - Consolidate CLI parsing, plan creation, and loop execution into a clean pipeline.
      - Remove legacy paths or logic that only exists for old naming/flow.
      - Ensure new commands reuse shared helpers instead of duplicating logic.
  4. State + prompt wiring
      - Add .loopy/hints.md (or similar) and include it in prompt formatting.
      - Expand .loopy/state.json for currentPhase, phase history, and last hint.
      - Improve loopy status output format.
  5. Tests
      - loopy loop --prompt generates `.loopy/LOOPY_PLAN.md` and auto‑phase plan.
      - loopy loop --prompt @file works the same.
      - loopy status output covers iteration, phase, last error, hints.
      - loopy hint appends and is reflected in next prompt.
      - loopy init scaffolds expected files.
  6. Docs
      - README quickstart (one‑command flow).
      - Document status, hint, init.
      - Explain plan file location + migration.
      - Advanced flags section.