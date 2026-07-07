## Why

A fix round dead-ends whenever there is no actionable work left to do, even
though the pipeline behaved correctly. Two paths produce this:

1. **All blocking findings already overridden.** The review comment freezes a
   `pipeline-blocking-keys` marker at review time. When an operator later records
   `--override` (a key or scope disposition) and `override-auto-resume` re-enters
   the advance loop, the fix stage's `extractBlockingReviewFindings` still filters
   only by that stale marker — it never re-consults the *live* override sentinels.
   The now-dispositioned findings are handed to the fix harness, which correctly
   makes no change, so `headBefore === headAfter`, salvage finds nothing, and
   `decideExternalCommitAdvance` fails closed → the round blocks with
   `blockerKind: "no-commits"` ("reported success but produced no new commits").

2. **A finding does not reproduce at the reviewed SHA.** The fix harness runs,
   correctly determines an assigned finding is a tooling artifact / non-issue at
   the reviewed tree, and makes no code change. There is no sanctioned channel for
   the harness to say "this does not reproduce," so the identical no-op → same
   `no-commits` block (castrecall #46: a review's only finding was a tooling
   artifact; the fix agent correctly declined to change code and the run
   dead-ended, requiring a manual stage-label rewind to recover).

Recovering from either today requires manual stage-label surgery on work that is
already correctly done. This change makes "nothing left to fix" a recognized,
automatically-handled outcome — without loosening review rigor: overridden
findings are excluded from a fix round *before* the harness runs, and a fix agent
that finds no reproducible issue has a sanctioned, audited, SHA-anchored way to say
so and let the pipeline proceed to the next **review** stage, which re-examines
independently.

## What Changes

- `core/scripts/stages/fix.ts` (fix-round entry): before invoking the harness,
  recompute the effective blocking set for the triggering review by subtracting the
  *live* trusted override sentinels (key + scope, via `extractOverrides` /
  `extractScopedOverrides` / `buildTrustedOverrideComments`, matched by
  `findingKey` / scope). When the effective set is empty, skip the harness and
  advance directly to the next review stage; when it is partial, invoke the harness
  scoped to only the remaining findings.
- `core/scripts/prompts/fix.md`: add a sanctioned **"does not reproduce"** outcome
  — when the harness makes no change because an assigned blocking finding does not
  reproduce at the reviewed SHA, it emits a controlled, per-finding machine-readable
  declaration (finding key + reviewed SHA + justification) in its output rather than
  silently making no commit.
- `core/scripts/stages/fix.ts` (no-commit path): when `headBefore === headAfter`
  and salvage is empty, parse the harness output for does-not-reproduce
  declarations; when a valid declaration covers **every** invoked blocking finding,
  record an audited SHA-anchored disposition and advance (round 1 → `review-2`,
  round 2 → `pre-merge`) instead of blocking. Any invoked blocking finding left
  neither committed nor declared still falls through to the existing `no-commits`
  block (fail closed).
- The recorded non-reproducing disposition is **SHA-anchored**: it is consulted on
  subsequent fix/review entry only when the reviewed SHA still matches, so the same
  finding does not re-trigger the same dead-end at the same tree, while any new
  commit (SHA change) re-opens the finding for a fresh review.

## Capabilities

### New Capabilities
- `fix-round-noop-advance`: A fix round with no actionable blocking work —
  because every blocking finding is overridden, or because the harness determined
  the findings do not reproduce at the reviewed SHA — advances automatically to
  the next review stage rather than dead-ending on the `no-commits` block.

### Modified Capabilities
- `fix-external-commit-advance`: The `no-commits` block on "HEAD equals the
  reviewed SHA" gains two carve-outs — an empty effective blocking set (all
  overridden) and a valid does-not-reproduce declaration covering every invoked
  blocking finding — so a correctly-determined no-op advances instead of blocking.

## Impact

- `core/scripts/stages/fix.ts`, `core/scripts/prompts/fix.md` (+ `prompts/index.ts`
  drift guard), and co-located tests. No state-machine edges change (the same
  `fix-1 → review-2` and `fix-2 → pre-merge` transitions are used).
- The normal fix-and-commit flow (genuine, non-overridden, reproducing findings)
  is unchanged. No new run-directory file; the disposition rides the existing
  audited-comment sentinel pattern.

## Acceptance criteria

- [ ] When a fix round begins and every blocking finding from the triggering
      review already has a recorded override, the fix harness is NOT invoked and
      the pipeline advances directly to the next review stage (round 1 → `review-2`,
      round 2 → `pre-merge`) without a `no-commits` block.
- [ ] When only some blocking findings are overridden, the fix harness IS invoked
      and its scope (the findings rendered into the fix prompt) reflects only the
      remaining, non-overridden findings.
- [ ] The fix harness has a distinct, sanctioned "does not reproduce at the
      reviewed SHA" outcome that is recognized by the fix stage and does NOT
      trigger the `blockerKind: "no-commits"` block.
- [ ] When the harness declares "does not reproduce" for every invoked blocking
      finding in a round, the pipeline advances to the next review stage without
      human intervention.
- [ ] The does-not-reproduce disposition is recorded as an audited, SHA-anchored
      sentinel and is consulted on subsequent runs, so re-entering fix or review
      for the same finding at the same reviewed SHA does not reproduce the dead-end;
      a change in the reviewed SHA re-opens the finding.
- [ ] A no-op round in which at least one invoked blocking finding is neither
      committed, overridden, nor validly declared non-reproducing still blocks with
      `blockerKind: "no-commits"` (fail closed).
- [ ] A fix round with genuine, non-overridden, reproducing findings behaves
      exactly as it does today (this change does not alter the normal
      fix-and-commit flow).
- [ ] The override pre-filter and the does-not-reproduce decision are exercisable
      through the existing fix-stage test seams with no real network, git, or
      subprocess calls, and the regression tests bite (fail against the pre-change
      fix stage).
