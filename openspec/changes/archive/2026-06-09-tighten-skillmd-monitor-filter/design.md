## Context

All three SKILL.md files (`plugin/pipeline/skills/pipeline/SKILL.md`, `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`) contain an identical section 4c that advises operators to tail the pipeline run's log file with a broad grep:

```bash
tail -f /tmp/pipeline-<domain>-<N>.log | grep -E --line-buffered \
  "^\[pipeline\]|^\[exit code|FAILED|timed out|blocked label|approved|needs-attention|→ "
```

The broad alternation was written to catch every plausible failure marker across the log, including substrings like `FAILED`, `timed out`, `→ ` that appear in structured failure output. However, the same substrings appear verbatim inside the unit-test fixture files: the eval-gate and state-machine tests assert on pipeline log lines and therefore contain strings like `[pipeline] #42: eval-gate … timed out; blocking` and `→ ready-to-deploy`. When the test gate stage (`npm test` / `npm run ci`) runs, it dumps the full test-suite output — including these fixture strings — to the same log file. The broad filter then matches hundreds of fixture lines in rapid succession.

This triggers the Monitor tool's auto-stop threshold (too many events in a short window), prematurely ending the Monitor and silencing the rest of the run. Observed live during the #16 run dogfood session (2026-06-08).

## Goals / Non-Goals

**Goals:**
- Replace the broad alternation with a tight, issue-scoped filter: `^\[pipeline\] #<N>: ` (where `<N>` is the specific issue number being run).
- Update the explanatory prose so future editors understand why the tight filter is preferred and will not inadvertently re-widen it.
- Apply consistently across all three SKILL.md host variants.
- Confirm in the guidance that no real signal is lost: every stage transition — including `done`, `blocked: …`, and `→ ready-to-deploy` — is prefixed with `[pipeline] #N:`.

**Non-Goals:**
- No changes to `pipeline.ts` or any other application code.
- No changes to what the stage handlers log (the `[pipeline] #N:` lines are correct as-is).
- No rerouting of test-gate stdout to a side log (explicitly deferred in the issue as a follow-up).
- No changes to monitoring mechanics outside the documented filter string.

## Decisions

### Decision 1: Use `^\[pipeline\] #<N>: ` (issue-number-anchored) rather than `^\[pipeline\] ` (prefix-only)

The issue-number anchor (`#<N>`) is the key tightening. Without it, `^\[pipeline\] ` would still match any `[pipeline] #42:` fixture lines that the test-suite emits for any issue number. Anchoring to the *specific* issue number being run limits matches to the current run's own transition lines only.

The operator already knows `<N>` — it is the argument they passed to `/pipeline N` — so substituting it is trivial.

**Alternative considered:** Keep `^\[pipeline\]` (no issue number) — rejected because test fixtures emit `[pipeline] #<other-N>:` lines for arbitrary issue numbers, so the prefix-only pattern still matches.

### Decision 2: Remove the "Known false-positives / broaden filter to catch failures" rationale

The current prose explicitly explains *why* the filter is broad ("we deliberately broaden the filter to catch real failures"). Once the filter is tightened, that rationale becomes misleading. The updated prose should instead explain:
- Why the tight filter captures all real signal (every transition starts with `[pipeline] #N:`)
- Why the broad filter was problematic (test-gate fixtures reproduce the matched substrings)
- That process exit (background task completion) independently signals run-end regardless of the log filter

### Decision 3: Apply identically to all three host files

All three files carry the same filter string and the same false-positive prose. A divergence between hosts would cause inconsistent operator behavior. All three must receive the identical update.

## Risks / Trade-offs

- **Risk: A future stage emits a real failure line that does NOT start with `[pipeline] #N:`** → Mitigation: audit of all `pipeline.ts` log emission points confirms every transition and failure marker is prefixed with `[pipeline] #N:`; the process-exit signal independently notifies on crash/timeout regardless of log content.
- **Risk: Operator copy-pastes the filter literally without substituting `<N>`** → Mitigation: the updated guidance should make the substitution requirement explicit and show a concrete example (e.g., for issue 64: `^\[pipeline\] #64: `).
