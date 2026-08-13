## 1. Inventory and seams

- [ ] 1.1 Add a machine-readable ship-path composition class inventory (constant or co-located module) with hard ids: `train-frontier-one-wave`, `train-code-dep-merge-barrier`, `train-independent-r2d-merge-partial-failure`, `scratch-only-no-needs-human`, `scratch-only-unlink-not-repair`; soft id `stale-blocked-rereview-before-train-stop` optional with open-issue waiver slot.
- [ ] 1.2 Map each inventory id to covering test name(s) or module path; prefer existing `train.test.ts`, dirt/recovery tests, and `stale-blocked-rereview.test.ts` where they already bite.
- [ ] 1.3 Add a drift-guard unit test that fails when a hard class lacks coverage registration or a registered covering test is missing.

## 2. Train composition bites

- [ ] 2.1 Ensure / add hermetic test that fails if one multi-item base-eligible frontier gets more than one advance-wave call or production wiring defaults to N×`single` / `advanceWaveFromSingle` (`train-frontier-one-wave`).
- [ ] 2.2 Ensure / add hermetic test that fails if code-dependent B enters an advance wave before A’s merge-result is contained (`train-code-dep-merge-barrier`).
- [ ] 2.3 Ensure / add hermetic test that fails if a proven-independent already-R2D sibling is not merged (or train aborts before that merge) solely because a peer is parked/blocked (`train-independent-r2d-merge-partial-failure`).
- [ ] 2.4 Confirm injected deps only (no real network, git, or subprocess) for all train composition tests.

## 3. Scratch-only composition bites

- [ ] 3.1 Ensure / add hermetic test that fails if scratch-only engine porcelain parks as `needs-human` / `pipeline:needs-human` or `setBlocked` solely for that porcelain (`scratch-only-no-needs-human`).
- [ ] 3.2 Ensure / add hermetic test that fails if scratch-only recovery invokes `repair_pipeline_item` instead of unlink/clear (`scratch-only-unlink-not-repair`).
- [ ] 3.3 Confirm product dirt still hard-blocks and is not a false composition failure.

## 4. Soft stale-block join (optional)

- [ ] 4.1 Either cover `stale-blocked-rereview-before-train-stop` with a hermetic test (STOP before resume fails) or record an open tracking-issue waiver in the inventory.
- [ ] 4.2 Do not weaken security denylist or true human-authority classes.

## 5. FRG / Layer A honesty (no Layer B pack expand)

- [ ] 5.1 Wire inventory into FRG Layer A ownership or co-located composition guard so hard classes cannot be silent gaps (tests required for #1029 hard acceptance; no hard-class waiver).
- [ ] 5.2 Do not expand fixed Layer B scenario pack ids solely for this issue; do not mint release-eligible FRG `pass: true` from offline composition alone.

## 6. Verification and packaging

- [ ] 6.1 Prove each hard-class test fails when the defective composition is reintroduced (or document equivalent bite from existing tests).
- [ ] 6.2 If any `core/` files change, run `node scripts/build.mjs` and commit regenerated `plugin/`.
- [ ] 6.3 Run `openspec validate frg-ship-path-composition-coverage` and `npm run ci`; both must pass.
