## Context

The pipeline's `[pipeline] #N:` lifecycle lines are emitted in two places:

- `core/scripts/pipeline-run.ts`: `printOutcome` (the `from → to: summary` advance
  line and the `at <stage> — <status>: <reason>` non-advancing line), plus the
  run-lifecycle lines `starting at stage=…`, `run id …`, `pipeline label removed;
  stopping.`, and the terminal `done — … (N transitions, Ns)` line.
- `core/scripts/pipeline.ts`: the `unblocked at <stage>` line.

All of them call `console.log`, which shares one stream with harness prose and —
critically — the test gate's full unit-test stdout, whose eval-gate and
state-machine fixtures reproduce `[pipeline] #<other-N>:` and `→ ready-to-deploy`
substrings (see the `monitor-filter-guidance` spec). That is why grep-based
monitoring of the full log is fragile.

The full operator log (`/tmp/pipeline-<domain>-<N>.log`) is **not** created by the
pipeline process — it is the operator's shell redirection target documented in
SKILL.md §4b (`… > /tmp/pipeline-<domain>-<N>.log 2>&1`). The transitions log, by
contrast, is written by the pipeline process itself, which knows `cfg.domain` and
the issue number and can therefore construct `/tmp/pipeline-<domain>-<N>.transitions.log`
unaided.

## Goals / Non-Goals

**Goals:**

- Give operators a grep-free, fixture-free real-time view of stage transitions.
- Keep the full log byte-identical to today (additive mirroring only).
- Reuse the existing `/tmp/pipeline-<domain>-…` naming convention so the path is
  derivable from the run arguments.
- Make the writer non-fatal and unit-testable through a dependency seam (no real
  filesystem in unit tests), matching the repo's `Deps` pattern.

**Non-Goals:**

- Structured JSON events (the `events.jsonl` / run-store stream owns that).
- Changing the full log or run-store `terminal.log` format/contract.
- Replacing the existing full-log grep guidance — it remains a valid fallback.

## Decisions

**Decision: mirror at the single print seam, not at each call site.**
Route the lifecycle lines through one helper (e.g. a `logTransition(line)` that
both `console.log`s and appends to the transitions file), and call it from
`printOutcome`, the run-start/`done` lines, and the `unblocked` line. This keeps
the "stdout copy === transitions copy" invariant trivially true and avoids
duplicating the path-construction logic. The helper is the natural place to apply
the non-fatal try/catch.

**Decision: derive the path from `cfg.domain` + `N`, append mode.**
`/tmp/pipeline-<domain>-<N>.transitions.log` matches `/tmp/pipeline-<domain>.lock`,
`/tmp/pipeline-<domain>.disabled`, and the documented full-log path. `<N>` is the
originally supplied argument (the same `<N>` the operator uses for the full-log
redirect), even when that number resolves to a different linked issue — so both
logs share one `<N>`. Open with `O_APPEND` (or `appendFileSync`) so re-entrant
dispatches accumulate rather than clobber.

**Decision: writes are best-effort and non-fatal.**
A `/tmp` write failure must never take down a run or change stdout. Wrap each
append in a try/catch that, on failure, still emits the stdout line and continues
— the same posture as the run-store's non-fatal `appendEvent`.

**Decision: `--cleanup` removes the per-issue transitions log it can attribute.**
The issue's acceptance criterion says the transitions file should be "cleaned up
by `--cleanup` alongside the full log." There is a real conflict to surface here:
`runCleanup` today only sweeps **merged-PR worktrees** (`sweepMergedWorktrees`); it
does **not** remove any `/tmp` log file, and the full operator log is
operator-created (shell redirection), so the pipeline cannot and should not delete
it. The faithful interpretation of the intent — don't let per-issue transitions
files pile up in `/tmp` — is to delete `/tmp/pipeline-<domain>-<N>.transitions.log`
for each issue `N` whose worktree the sweep removes (the branch name yields `N`).
This is best-effort: a missing file or a failed unlink must not abort the sweep.

**Decision: keep the existing full-log monitor guidance; add transitions-log as
preferred.** The `monitor-filter-guidance` capability governs the **full-log**
grep filter and stays valid for operators tailing the full log. This change adds a
new, additive recommendation (tail the transitions log, no grep) rather than
modifying that capability, keeping the change focused and avoiding a guidance
regression.

## Risks / Trade-offs

- **Two log files per run.** Mitigation: the transitions log is tiny (≤ ~20 lines
  per run) and is reclaimed by `--cleanup`; the full log is unchanged.
- **Drift between stdout and the transitions log.** Mitigation: a single print
  seam guarantees identical bytes, and a unit test asserts the mirrored line
  equals the stdout line for each lifecycle kind.
- **`<N>` vs. linked-issue ambiguity.** Mitigation: pin the path to the originally
  supplied argument so it always matches the documented full-log path.
- **SKILL.md / plugin mirror drift.** Mitigation: edit `hosts/*` only, regenerate
  `plugin/` via `node scripts/build.mjs`, and let `build.mjs --check` enforce it.

## Migration Plan

1. Add the append-only transitions writer behind a dependency seam.
2. Route `printOutcome`, the run-start/`done` lines, and the `unblocked` line
   through it; wrap appends as non-fatal.
3. Extend `runCleanup` to unlink the transitions log for each swept merged-PR
   issue (best-effort).
4. Update `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` monitoring guidance;
   regenerate the `plugin/` mirror.
5. Add unit tests (mirror-equals-stdout for each lifecycle kind, append-not-truncate,
   non-fatal-on-write-error, cleanup-unlinks) and run `npm run ci`.

Rollback is removing the writer wiring and the SKILL.md guidance; no external state
is mutated.

## Open Questions

- None. The `--cleanup` scope (per-swept-issue, best-effort) is settled above.
