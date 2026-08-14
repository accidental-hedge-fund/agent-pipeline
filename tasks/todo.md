# #1065 Plan revision — pre-merge never park merge-conflict

## Status
- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [ ] Implementation (blocked on plan acceptance / next pipeline stage)

## Reviewer feedback dispositions
See chat response `## Feedback Incorporated` (authoritative for this revision).

## Locked decisions (post-review)
1. Single entry: `recoverFromMergeConflict` (early Step 0.5 + post-CI Step 2).
2. State machine: clean-rebase → conflict-resolve → push / product-fail.
3. Ledger: `conflict_rebase` (clean only) + new `conflict_resolve` (resolve budget).
4. Exhaust terminal: `BlockerKind` `review-findings` (not `merge-conflict`).
5. Keep mid-rebase worktree; abort only after terminal / non-conflict fail cleanup.
6. Train: first-conflict returns `waiting`, never false human park.

## Implementation sequence (post-approval)
1. Ledger action `conflict_resolve` + pure reconcile helpers + conflict-file probe seams
2. `tryRebaseAndPush` split: clean rebase, conflict detect, resolve continue, force-with-lease
3. `recoverFromMergeConflict` state machine + implementer/deterministic resolve seams
4. Update tests that expect instant merge-conflict park; add #1061 regressions
5. Offramp/taxonomy only if production path still emits wrong terminal
6. `node scripts/build.mjs` + `openspec validate` + `npm run ci`
