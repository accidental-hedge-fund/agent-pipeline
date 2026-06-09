## Why

The orchestration guidance in all three `SKILL.md` files (section 4c) recommends a broad `grep -E` filter that matches `→`, `FAILED`, `timed out`, and similar strings. When the test gate runs the full unit-test suite, the suite output includes eval-gate and state-machine fixtures that reproduce exact `[pipeline] #N:` and `→ ready-to-deploy` log lines — causing the Monitor to emit hundreds of events at once, triggering the Monitor's auto-stop threshold, and flooding the user's notification stream with no useful signal.

## What Changes

- Replace the broad alternation filter in SKILL.md section 4c with a tight pattern anchored to the specific issue number: `^\[pipeline\] #<N>: `
- Update the explanatory prose in section 4c to describe *why* the tight filter is correct: all real transitions — including `done`, `blocked: …`, and `→ ready-to-deploy` — begin with `[pipeline] #N:`, so no real signal is lost; the test-gate fixture lines that triggered false positives are anchored to *other* issue numbers and are therefore excluded
- Remove (or accurately rewrite) the "Known false-positives" paragraph that currently instructs operators to widen the filter to catch real failures — those failures are now captured by the tight `[pipeline] #N:` prefix
- Apply the same update to all three hosts: `plugin/pipeline/skills/pipeline/SKILL.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`

## Capabilities

### New Capabilities
- `monitor-filter-guidance`: Documents the correct, issue-scoped Monitor grep filter and the rationale for preferring it over the broad alternation pattern.

### Modified Capabilities
<!-- No existing spec-level behavior changes — all currently shipped specs are unaffected. -->

## Impact

- **Documentation only** — three `SKILL.md` files are edited; no application code, no pipeline.ts logic, no test changes.
- Operators following the guidance from the updated SKILL.md will issue a tighter grep command, reducing Monitor event volume from O(hundreds) to O(10–18) per full run.
- The change is safe: every real `[pipeline] #N:` transition line already carries the issue-number prefix; background task completion (process exit) continues to signal run-end independently of the log filter.
