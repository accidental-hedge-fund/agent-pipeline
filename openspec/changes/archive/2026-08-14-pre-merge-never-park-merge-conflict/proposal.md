## Why

Pre-merge already owns merge-conflict recovery (`recoverFromMergeConflict` /
`tryRebaseAndPush`), but on the first `git rebase` conflict it aborts and parks
the issue with `BlockerKind` `merge-conflict` and the terminal text
“manual rebase needed.” Operator law (2026-08-14): merge-conflict is **not** a
human gate. Live instance #1061 PR #1064 parked at 18:07Z after additive
CLI help-string conflicts — a class a human finished in minutes — while train
moved on to the next issue. One failed `git rebase` is not recovery.

## What Changes

- **BREAKING (product behavior):** Pre-merge SHALL NOT park a true base-branch
  merge conflict as a human `merge-conflict` / “manual rebase needed” terminal
  after a single auto-rebase failure.
- On rebase conflict during pre-merge recovery, the engine SHALL keep the managed
  worktree, attempt conflict resolution (deterministic resolver and/or the
  configured implementer under a bounded budget), finish the rebase, push
  `--force-with-lease`, and re-enter pre-merge (CI / mergeability) without
  applying `pipeline:blocked` for that reason alone.
- Only when the implementer (or resolver) budget is exhausted **and** the tree
  is still conflicting MAY the item fail closed — and then as a product /
  engine-owned failure (e.g. `review-findings` or equivalent product-failure
  path) that names the conflict files and residual evidence, **not** as
  `merge-conflict` “manual rebase needed.”
- The #1061 18:07Z blocked-comment text is not a legal terminal state for this
  path. Regression coverage SHALL reject that terminal.
- Train / multi-item advance SHALL NOT treat a first-conflict auto-rebase miss
  as a completed human park that frees the wave to start the next issue solely
  because that park fired (same item remains in engine recovery).
- Stage-attempt ledger bounds remain so recovery cannot thrash forever; the
  bound drives implementer/resolver escalation and budget exhaustion, not an
  immediate human park.

## Acceptance Criteria

- [ ] First failure of plain auto-rebase (`tryRebaseAndPush` / equivalent) on a
      CONFLICTING or DIRTY PR does **not** call `setBlocked(..., "merge-conflict")`
      with a “manual rebase needed” reason.
- [ ] On that conflict, the managed worktree is kept and a bounded conflict
      resolution path runs (deterministic and/or configured implementer) before
      any terminal block.
- [ ] Successful resolution pushes the branch with `--force-with-lease` and
      returns a non-blocked pre-merge outcome that re-enters CI / mergeability
      (e.g. waiting “rebase-resolved; CI re-running” or equivalent).
- [ ] A hermetic fixture models the additive `pipeline.ts` help-string union
      conflict class (#1061 / #1064 style); resolution + push complete without a
      `blocked` label and without `BlockerKind` `merge-conflict`.
- [ ] After implementer/resolver budget exhaustion with a still-conflicting tree,
      the terminal outcome is a product / engine-owned failure that includes
      conflict-file evidence — **not** the legal terminal string
      “could not be automatically rebased — manual rebase needed” under
      `merge-conflict`.
- [ ] Unit/regression tests fail if the #1061 18:07Z-class comment text is
      emitted as a legal pre-merge terminal for first-conflict auto-rebase miss.
- [ ] Multi-item / train disposition does not treat first-conflict park as a
      reason to start the next issue while this item is still unmerged solely
      because that park fired.
- [ ] Existing ledger one-shot claim semantics still prevent infinite rebase
      loops; bounds charge resolver/implementer work rather than instant human park.
- [ ] Unit tests inject deps only (no real network/git/subprocess); `npm run ci`
      green; regenerate `plugin/` if `core/` changes.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `pre-merge-conflict-detection`: Replace “one failed auto-rebase →
  `setBlocked` merge-conflict / manual rebase” with “keep worktree → bounded
  resolve → push → re-enter pre-merge”; budget-exhausted residual conflict is a
  product/engine-owned failure, not a human merge-conflict park.
- `human-intervention-taxonomy`: Clarify that pre-merge base-branch merge
  conflict is **not** a human-authority class by default; reporting projection
  must not authorize a human hold for first-conflict auto-rebase miss.
- `blocked-recovery-recipes`: Pre-merge recovery path for true merge conflicts
  MUST NOT terminate on the merge-conflict “manual rebase needed” recipe as the
  first-conflict outcome; residual recipe text for the kind remains only if
  other surfaces still use the kind, and must not be the legal pre-merge
  first-conflict terminal.
- `pre-merge-offramp-classification`: Align offramp class mapping so a first
  auto-rebase conflict does not durable-record a human merge-conflict offramp as
  the terminal disposition; budget-exhausted product failure maps to the
  engine-owned product path, not “manual rebase.”

## Impact

- **Code (intent for later implement):**
  `core/scripts/stages/pre-merge-conflict-rebase.ts` (`tryRebaseAndPush`,
  `recoverFromMergeConflict`, ledger claim completion), call sites in
  `pre-merge-routing.ts` (early conflict + post-CI conflict), related CI-gate
  rebase helpers if they share the same terminal park, blocked-comment /
  taxonomy / offramp mappers only as required by the new terminal classes.
- **Reuse:** stage-attempt ledger (`conflict_rebase`), candidate-integrity
  mutation wrap, configured implementer harness, surgical-fix discipline for
  conflict-only diffs, existing push-auth `--force-with-lease` path.
- **Related but out of scope:** #1063 (merge R2D / do not skip unmerged previous
  item) remains a separate change; this issue only requires that *this* false
  human park not free train to abandon the item. Merge-queue repair holds
  (`merge-queue-repair-hold`) are a different surface and stay operator-gated.
- **Ship:** v1.39.1 — do not fold into the in-flight v1.39.0 ship.
- **Tests:** hermetic regression for #1061 terminal text + additive help-string
  fixture path; update any tests that currently expect instant `merge-conflict`
  park after one failed `tryRebaseAndPush`.
