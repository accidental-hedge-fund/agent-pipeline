## 1. Evidence extractor: last terminal wins

- [x] 1.1 Extend the shared train advance-wave evidence extractor so a later successful terminal for the same item (`ready_to_deploy`, ledger `ready`, or wave `all_done` / `loop_run_complete` with no later `loop_run_stopped`) clears that item’s current `loop_item_blocked` fields.
- [x] 1.2 Keep wave `loop_run_stopped` as current stop evidence even when live labels later say ready-to-deploy.
- [x] 1.3 Scope the successful-terminal clear to the same item. A sibling that is still blocked keeps its blocked class.
- [x] 1.4 Unit-test the extractor: `loop_item_blocked` (`implementation-ci`) then later `ready_to_deploy` / `all_done` does not leave that class as current evidence for the item.

## 2. Classifier: recovered block is not a failed R2D wave

- [x] 2.1 Change shared train advance-label classification so live `pipeline:ready-to-deploy` without a live `blocked` label is ok / terminal `ready-to-deploy` when the only structured evidence is a recovered (superseded) item block.
- [x] 2.2 Keep #1074: live `pipeline:ready-to-deploy` plus current `loop_run_stopped` or non-zero engine failure / engine message remains `ok: false`.
- [x] 2.3 Live `blocked` label still parks; it is not a recovered-success merge candidate.
- [x] 2.4 Unit-test classification for 2.1, 2.2, and 2.3 with injected labels and evidence (no network, git, or subprocess).

## 3. Merge-mode train uses the recovered R2D outcome

- [x] 3.1 Add or extend a merge-mode train fixture that injects the recovered-block-then-R2D wave and asserts the existing merge surface is invoked for that item.
- [x] 3.2 Assert the train does not STOP with a reason whose sole current class is the recovered `loop_item_blocked` class (for example `implementation-ci on #<N>`).
- [x] 3.3 Do not add a second merge path. Advance/loop still never merge.

## 4. Ledger ready transition clears current blocked_theme

- [x] 4.1 When the store records an item transition to `ready`, omit current `blocked_theme` from the written entry. Keep history that recorded the prior block.
- [x] 4.2 Do not change recovery resume to `in_progress`: that path still retains `blocked_theme`.
- [x] 4.3 Unit-test 4.1 and 4.2 through the existing ledger write seam.

## 5. Mirror and gate

- [x] 5.1 If `core/` changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 5.2 Run `npm run ci` and fix any failures until green.
