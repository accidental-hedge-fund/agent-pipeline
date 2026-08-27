## Why

`pipeline ship --milestone v1.39.14` merged every train item, then exited 1 instead of starting FRG/release. `observeTrain` treats GitHub `CrossReferencedEvent` records from pipeline squash titles `… (#N)` as non-links because `willCloseTarget` is false, so integration proof returns null. This is a pipeline bug, not operator error. The in-flight v1.39.14 ship is blocked on this false negative.

## What Changes

- Shared any-state issue→PR lookup (the helper `observeTrain` and train merge-wave already call) SHALL treat a merged same-repo pipeline PR as a link when any of these identities hold:
  1. existing `ConnectedEvent` or `CrossReferencedEvent` with `willCloseTarget: true`, **or**
  2. same-repo PR whose head is `pipeline/<N>-*`, **or**
  3. same-repo PR whose title contains the parenthetical `(#N)` (GitHub squash mention, not `Fixes #N` / `Closes #N`).
- `observeTrain` SHALL use that lookup, then prove the PR is `MERGED` and its merge OID is an ancestor of the candidate head (`origin/<base>`). It SHALL NOT require an open PR.
- When that proof succeeds, ship `convergeTrain` SHALL NOT invoke `runTrain`. Coordinator `next_action` SHALL be the first post-train phase (`frg_pack` / FRG / release), not `train_merge`.
- Train merge-wave SHALL inherit the same lookup so resume does not STOP with `ready-to-deploy but has no linked open PR` after the items are already on `origin/<base>`.
- Fork PRs (`isCrossRepository`) stay ignored. Open-PR `getPrForIssue` stays branch-prefix + `closingIssuesReferences` only (no title search on the open path).
- Unknown keys / profile-filled harnesses stay out of scope (#1264). Do not finish v1.39.14 by hand-running FRG/release around a null `observeTrain`.

## Acceptance criteria

- [ ] Fixture: three issues, merged same-repo PRs, timeline `CrossReferencedEvent` with `willCloseTarget: false`, merge OIDs ancestors of `origin/main`. `observeTrain` returns complete train evidence with `integrated_head_oid`.
- [ ] Same fixture: `runTrain` is not invoked (no STOP on missing open PR).
- [ ] `Fixes #N` / `ConnectedEvent` path still resolves and proves integration.
- [ ] Fork PRs (`isCrossRepository`) still ignored.
- [ ] After observe succeeds, coordinator `next_action` is FRG/release (`frg_pack` or later), not `train_merge`. `complete` is not left false solely because proof was null.
- [ ] A train merge-wave fixture with the same non-closing `(#N)` merged PRs classifies items already-integrated. It does not STOP with `ready-to-deploy but has no linked open PR`.
- [ ] Unrelated non-pipeline mentions (`willCloseTarget: false`, head not `pipeline/<N>-*`, title not `(#N)`) still do not resolve as the issue's PR.
- [ ] Unit tests via injected deps; `plugin/` regenerated after any `core/` edit; `npm run ci` green.

## Capabilities

### New Capabilities

<!-- None. This extends existing any-state PR resolution, ship train observation, and train merge-wave integration proof. -->

### Modified Capabilities

- `pr-resolution`: Any-state lookup (`getPrForIssueAnyState` / timeline picker) SHALL accept a same-repo pipeline PR as a link when `ConnectedEvent`, closing `willCloseTarget`, head `pipeline/<N>-*`, or title parenthetical `(#N)` matches. Mere non-pipeline mentions stay unmatched. Fork PRs stay ignored. Open-path `getPrForIssue` SHALL NOT gain title search.
- `ship-coordinator`: `observeTrain` SHALL treat those merged contained PRs as complete train evidence. Ship SHALL NOT re-enter `runTrain` when planned issues are already merged into `origin/<base>`. After proof, `next_action` SHALL be FRG/release, not `train_merge`.
- `integrated-train-mode`: Merge-mode "linked merged PR" reconciliation SHALL use the same any-state identities. A ready-to-deploy item whose only link is a merged `(#N)` / `pipeline/<N>-*` PR contained in base SHALL be already-integrated, not a no-open-PR STOP.

## Impact

- `core/scripts/gh.ts` — `pickPrFromTimelinePage` / `getPrForIssueAnyState` GraphQL fragment and match rules (issue-scoped timeline, not a repo-wide `gh pr list`).
- `core/scripts/stages/ship-adapter.ts` — `observeTrain` / `convergeTrain` (proof then skip `runTrain`).
- `core/scripts/stages/train.ts` — merge-wave already-integrated path inherits the lookup.
- `core/test/gh-parsers.test.ts`, `core/test/ship-adapter.test.ts`, and `core/test/train.test.ts` — injected-dep regressions for the v1.39.14 fixture.
- Generated `plugin/` mirror after any `core/` edit.
- No `auto_merge` config, no merge inside advance/loop, no change to FRG/release/tag/promote mutation once train evidence is proven.
