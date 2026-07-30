## Why

Pre-merge delta review can re-raise a finding that is **already fixed (or never true) on the
current PR head**. The bounded auto-fix harness then correctly makes no commit (clean worktree),
and today's path still escalates to `blocked` / `needs-human` with *“fix harness ran but left
worktree clean with no new commit — no recoverable work.”* Operators are stranded even when CI is
green and the cited defect is gone — as in the #683 / PR #696 dogfood (stale
`openspec-invalid` vs code that already routes that path to `needs-human`). Disclosure (#553)
improved the message but did not prevent the hard block.

## What Changes

- When a pre-merge delta **bounded auto-fix** ends with `headAfter === headBefore`, a clean
  worktree, and nothing salvageable, the pipeline **SHALL NOT** treat that alone as sufficient
  to set `blocked` / `needs-human`.
- The pipeline **SHALL** re-verify the still-open delta blocking findings against the **current**
  PR head (re-run the delta review, or an equivalent deterministic “is this finding still true on
  HEAD?” check). That re-verify is **not** a second fix attempt — the one-attempt bound stays.
  - Re-verify **clean** (finding gone / not reproducible) → pre-merge proceeds; record evidence
    that auto-fix was a no-op because the code already matched the recommendation or the delta
    was a false positive.
  - Re-verify **still broken** → escalate to `needs-human` **once**, with an explicit recipe that
    auto-fix produced no diff and the finding is still present at the cited path.
- Dirty worktree, harness failure/timeout, salvage, and prior-auto-fix-commit paths stay as
  specified today (salvage → push → re-review; dirty/fail → fail-closed escalate).
- Delta review (and/or the gate that consumes it) **SHALL** fail closed on unsupported “still
  broken” classification/control-flow claims when HEAD already implements the recommended
  behavior and no contradictory executable evidence is cited (prefer re-read of cited lines /
  cheap deterministic assertion for pure classification claims, as in #683).
- Block comment text **SHALL** distinguish no-op + re-verify clean (no block), no-op + still
  broken (human fix recipe), and existing error/salvage paths.
- **Optional (recommended):** durable loop schedule **SHALL NOT** advertise an actionable
  `advance` for a GitHub-`pipeline:blocked` item that has no unblock path — avoid idle
  reconcile spin to `supervisor_no_progress` with confusing `next_actions: N → advance`.

## Acceptance criteria

- [ ] Auto-fix no-commit with clean worktree + re-verify clean → pre-merge proceeds without
      `blocked` / `needs-human`.
- [ ] Auto-fix no-commit with clean worktree + re-verify still broken → exactly one
      `needs-human` escalation; block body states auto-fix made no diff and the finding is still
      present at a named path (or equivalent explicit recipe).
- [ ] One-attempt bound preserved: re-verify after a clean no-op does not launch a second
      bounded auto-fix attempt for the same finding round.
- [ ] Dirty / timeout / salvage paths are unchanged (salvage still commits+pushes+re-reviews;
      unclean/unrecoverable failures still fail closed).
- [ ] #683-class stale classification finding does not hard-block when HEAD already implements
      the recommended control-flow (e.g. `needs-human` instead of inflating `openspec-invalid`).
- [ ] Unit tests with injected auto-fix + delta (or HEAD-check) seams exercise no-op → re-verify
      clean and no-op → still-broken; tests bite if re-verify is skipped or a second fix is
      launched. No live network/git/subprocess in unit tests.
- [ ] Optional: loop reconciliation does not emit actionable `advance` for items that are
      GitHub-`pipeline:blocked` without an unblock path.
- [ ] OpenSpec change validates (`openspec validate pre-merge-auto-fix-noop-reverify`); living
      capability deltas stay archive-ready.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `pre-merge-fix-round`: clean no-commit after a bounded auto-fix attempt is no longer an
  automatic hard block; introduce re-verify-on-noop terminal policy, one-attempt-preserving
  re-review, and distinct block-comment recipes.
- `pre-merge-delta-recheck`: post-auto-fix no-op path re-enters delta (or equivalent HEAD)
  verification; delta must not treat unsupported false “still broken” classification claims
  as blocking when HEAD already matches the recommendation.
- `harness-uncommitted-salvage`: the #553 “ran but no recoverable work” pre-merge disclosure
  no longer implies immediate `needs-human`; disclosure remains, but terminal disposition is
  re-verify then proceed or escalate with recipe.
- `loop-blocked-item-hold-continuation`: optional — schedule / `next_actions` must not present
  blocked pre-merge items as immediately advanceable without clear/unblock.

## Impact

- **Code (implementation phase, not this step):** `core/scripts/stages/pre_merge.ts`
  (`performPreMergeAutoFix` result shape + delta block path after auto-fix), possibly a small
  status variant for clean no-op vs generic error; unit tests in `core/test/pre-merge-autofix.test.ts`
  and related pre-merge delta tests; optional loop reconcile / next-action logic under
  `core/scripts/loop/`.
- **Specs:** deltas under the modified capabilities above; after archive, living requirements
  replace today’s “clean no-commit → error → needs-human” contract for the pre-merge path only.
- **Non-goals:** #680 allowlist expansion; #181 CI fail-closed policy; auto-merge; inventing
  empty commits when HEAD is already correct; changing dirty-tree salvage (#547).
- **Dogfood / related:** #683 / PR #696; #359 auto-fix; #553 clean diagnostic; #496 delta
  re-assert (closed); #547 salvage.
