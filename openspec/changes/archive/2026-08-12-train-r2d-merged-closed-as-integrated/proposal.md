## Why

`pipeline train --merge` hard-stops on issues that are already finished: label still `pipeline:ready-to-deploy`, linked PR merged, issue closed, and no open PR left to merge. Observed on Ship milestone v1.38.0 after #1010 integrated — #927 (CLOSED + PR #1009 MERGED + stale R2D) killed the train with `ready-to-deploy but has no linked open PR`. A successfully shipped issue must not fail the rest of the milestone train.

## What Changes

- In `train --merge`, when an item is at `pipeline:ready-to-deploy` (or equivalent) and the only linked PR is **merged** (and/or the issue is **closed** as completed), treat the item as **`already-integrated` / skip** — do **not** stop the train.
- Resolve linked PRs for integration reconciliation across **open, closed, and merged** states (open-only lookup is insufficient after merge).
- When a merge commit OID is available, prove containment in the configured base using the same integrated proof path as today's already-merged case.
- Emit `ready-to-deploy but has no linked open PR` only when the issue is still **merge-eligible** (still open / not completed) and truly has no open mergeable PR.
- Prefer **ignoring** stale R2D on closed integrated issues in the train work path so they are not re-queued as merge work. Optional label hygiene (clearing R2D after merge/close) is out of band unless a minimal, safe hook already exists — train correctness must not depend on label mutation.

## Acceptance criteria

- [ ] Fixture: issue **closed** + linked PR **merged** + label `pipeline:ready-to-deploy` → `train --merge` records `already-integrated` (or equivalent skip), continues or completes, exit code 0 for that path (does not stop the train).
- [ ] Fixture: issue **open** + label `pipeline:ready-to-deploy` + **no** linked open or merged PR → train stops with a clear blocker (existing or refined "no linked open PR" class message) and non-zero exit.
- [ ] Fixture: issue **open** + R2D + linked **open** PR → train still merges and proves base containment as today.
- [ ] Fixture: open R2D + already-merged PR with merge OID contained in base → already-integrated skip without a second merge mutation (existing idempotent path still holds when any-state lookup finds the PR).
- [ ] Unit regression tests cover the closed+merged+R2D case and the open-no-PR fail-closed case; `npm run ci` green; `plugin/` mirror regenerated if `core/` changes.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `integrated-train-mode`: Train merge-mode reconciliation MUST treat closed issues with a merged linked PR (and open issues with a since-merged linked PR and no open PR) as already integrated when merge-result containment holds (or when issue completion + merged PR is sufficient per design). MUST NOT hard-stop on "no linked open PR" for those finished items. MUST still fail closed for open merge-eligible R2D issues with no PR.

## Impact

- `core/scripts/stages/train.ts` merge-wave / already-integrated reconciliation (and `TrainDeps` if an any-state PR resolver is added).
- Likely reuse of existing `getPrForIssueAnyState` (or equivalent) from `gh.ts` / reconciliation — no new GitHub authority surface.
- `core/test/train.test.ts` regression fixtures.
- Generated `plugin/` mirror after `core/` edits.
- No change to advance-only train semantics beyond consistent "already done" handling.
- No auto-merge without an open PR; no `auto_merge` config; merge authority boundary unchanged.
