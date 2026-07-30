## Context

Two call sites run format/test gates after developer work lands in a worktree:

1. **Fix** (`stages/fix.ts` / `advanceFix`) — after the fix harness commits, already
   runs `includeLockfileSideEffects` (#358) before `runFormatAndTestGates`.
2. **Implement / post-implementation** (`stages/planning.ts` →
   `resumeFromImplementing`) — after implement commits (or on resume when commits
   already exist), jumps straight into `runFormatAndTestGates` with **no** lock
   fold.

Implement salvage (`salvageIfNoNewCommit` / #131) only fires when HEAD did **not**
advance. When the implementer produced real commits and left a lock dirty (e.g.
root-level `npm install` creating `?? package-lock.json` while the repo tracks
`core/package-lock.json`), salvage is skipped, gates see dirt, and the testgate
pre-dirty check blocks with `attempts: 0` without ever running the test command.

A second, independent bug compounds the operator experience: `testGateBlockReason`
wraps **all** non-tooling / non-build failures in:

> Test/build gate failed after N fix attempt(s); the repo's own test/build
> command is still failing…

including pure pre-dirty blocks where the command never started. Observed on
#674 second advance (`674-2026-07-30T17-32-26-856Z`).

Existing building blocks (do not reimplement):

- `core/scripts/lockfile-side-effects.ts` — `includeLockfileSideEffects`,
  recognized basenames, amend-no-edit, injectable seams, unit tests.
- Living spec `fix-commit-lockfile-inclusion` — behavioral contract for the fix path.
- `test-build-gate` — clean-tree trust; dirty blocks already have distinct
  `blockReason` text and path disclosure (#352); only the outer formatter is wrong.

## Goals / Non-Goals

**Goals:**

- Implement / post-implementation path has **parity** with fix for lock-file
  side-effect fold before format/test gates.
- Operator-facing blockers distinguish **dirty-tree refusal** from **test command
  failure / fix-attempt exhaustion**.
- Reuse the existing helper and recognition rules; minimal surface area.
- Biting regressions for both behaviors.

**Non-Goals:**

- Auto-including non-lock dirt or weakening the clean-tree trust model.
- Changing when package managers run, install bootstrap, or worktree capacity (#718).
- Expanding salvage to always stage leftover files when HEAD advanced.
- Special-casing “new root lock the repo never tracked” into delete-by-default —
  default is fold-parity with fix; disposition of unwanted root locks remains a
  product/repo concern if it ever needs a different rule.
- Auto-merge or merge-surface changes.
- Operationally clearing #674’s current blocked state (manual recovery stays
  available; this change prevents the class of hold).

## Decisions

**Decision: call `includeLockfileSideEffects` from `resumeFromImplementing` before
`runFormatAndTestGates`.**

Rationale: both the first-pass implement handoff and the dispatch resume path
funnel through `resumeFromImplementing`. One call site covers both without
duplicating fold logic next to salvage in the implement harness success path only.
Fix already folds inside `advanceFix`; implement gets the shared post-implementation
entry.

Alternatives considered:

- *Only after implement harness success (not on resume).* Misses resume-after-unblock
  when lock dirt remains and gates re-run.
- *Inside `runFormatAndTestGates`.* Would also affect fix (double-fold harmless but
  surprising) and every future caller; broader than needed; mixes gate certification
  with commit-shaping side effects.
- *Broaden salvage when HEAD advanced.* Would stage **all** dirt, not just locks —
  out of scope and conflicts with intentional dirty-tree refusal for non-lock paths.

**Decision: do not require `headBefore !== headAfter` on the implement call site.**

On resume, this process may not have recorded a harness `headBefore`. The helper is
already a pure status→fold: no lock dirt → no git writes. Fix keeps its
commit-produced gate because salvage already handled the no-commit case; implement
resume has no analogous “only if this process just committed” need for locks — if
locks are dirty before gates, fold them. HEAD must exist for amend; an empty repo
edge case is outside normal pipeline worktrees.

**Decision: reuse amend-no-edit and lock-only pathspecs from #358 unchanged.**

Same recognition (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` at any depth),
same temporary unstage of pre-staged non-lock paths, same trailer preservation.
Inject via a deps seam on `ResumeFromImplementingDeps` (e.g.
`lockfileSideEffects`) mirroring `AdvanceFixDeps`.

**Decision: default is fold even for a newly created root lock the repo may not
track as product.**

Issue text allows documenting fold-vs-delete for never-tracked root locks; default
matches fix-path fold for consistency. Deleting untracked root locks is **not**
part of this change — wrong default for repos that *do* track root locks, and
harder to reverse. Operators / later issues can tighten install hygiene separately.

**Decision: fix dirty-block messaging via a distinct gate result flag (or equivalent)
that `testGateBlockReason` respects — parallel to `toolingFailure` / `buildFailure`.**

Pre-dirty and post-run-dirty paths already set a clear `blockReason` and
`attempts: 0`. The bug is the wrapper in `testGateBlockReason`. Prefer something
like `dirtyWorktree: true` (or a shared “pass-through reason” channel) so:

- dirty `blockReason` is returned as-is (or with a thin, accurate prefix that does
  **not** claim command failure / fix exhaustion);
- exhausted fix-loop failures keep the existing wrapper;
- tooling/build flags remain as today.

Alternatives considered:

- *Heuristic string-match on blockReason.* Fragile; fails if copy changes.
- *Change only implement-path setBlocked copy.* Misses fix-path dirty blocks that
  go through the same formatter; operator confusion is gate-wide.

**Decision: regression tests at two seams.**

1. Implement path / `resumeFromImplementing`: with fake porcelain reporting an
   uncommitted lock, assert fold is invoked before the gates runner; prove bite by
   removing the call or asserting order (fold before `_runFormatAndTestGates`).
2. `testGateBlockReason` (or gate + formatter integration): a pre-dirty result with
   `attempts: 0` must not match `/failed after \d+ fix attempt/i` or claim the
   command is still failing; must still surface uncommitted path disclosure.

Tests inject deps; no real git/network/subprocess.

## Risks / Trade-offs

- **[Risk] Amend rewrites tip SHA after implement commits but before push.**
  → Mitigation: same as #358 — push is after gates in `resumeFromImplementing`;
  amend is pre-push. Resume after a prior partial push of the same tip is rare for
  this failure mode (gate never passed, so push usually did not run); if a prior
  push did occur and dirt remains, amend + non-force push can fail — existing
  push/block paths surface that; out of scope to invent force-push.

- **[Risk] Folding a near-empty root lock into HEAD pollutes the PR.**
  → Mitigation: parity with fix; better than human-gated false test failure. Hygiene
  (don’t run root `npm install` when only `core/` is the package) is a separate
  implementer/prompt concern.

- **[Risk] Double fold if fix later shares more code with implement.**
  → Mitigation: helper is idempotent when no lock dirt remains after first fold.

- **[Risk] Messaging flag misses some dirty paths if only pre-dirty is tagged.**
  → Mitigation: tag both pre-run dirty and post-run dirty results that never
  entered the fix loop (both currently use attempts 0 and distinct reason text).

## Migration Plan

- Ship as a normal pipeline PR; no config migration.
- No living-spec archive until implement + review complete; this change only authors
  the OpenSpec proposal artifacts first.
- Rollback: revert the call site and messaging flag; behavior returns to #674-class
  holds (undesirable but safe).

## Open Questions

None blocking implementation. Optional follow-ups (not this change): install-hygiene
prompt guidance to avoid spurious root locks; FRG scenario under #723 for implement
lock side-effects (referenced by issue comments).
