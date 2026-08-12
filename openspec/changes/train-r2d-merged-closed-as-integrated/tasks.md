## 1. Train reconciliation surface

- [ ] 1.1 Extend `TrainDeps` (or equivalent) so merge-mode reconciliation can resolve a linked PR across open/closed/merged states (real wiring: reuse `getPrForIssueAnyState` or the same timeline resolution used by reconcile/ship-adapter).
- [ ] 1.2 Update the early already-integrated path in `runTrain` merge mode to use any-state PR resolution, observe merge state, and prove base containment when a merge-result OID is available.
- [ ] 1.3 Update the merge-wave "no linked open PR" branch: if any-state reconciliation finds a merged linked PR, classify `already-integrated` / skip; only emit the no-open-PR blocker for still merge-eligible (open) R2D issues with no open and no merged linked PR.
- [ ] 1.4 Keep open-PR merge path and advance-only train behavior unchanged except where shared helpers require it.

## 2. Regression tests

- [ ] 2.1 Add unit fixture: closed issue + merged PR + `pipeline:ready-to-deploy` → `train --merge` records already-integrated, no merge mutation, exit 0 (or continues to next items).
- [ ] 2.2 Add unit fixture: open R2D + no open/merged PR → non-zero exit with no-open-PR class blocker.
- [ ] 2.3 Add or retain fixture: open R2D + open PR still merges and proves containment.
- [ ] 2.4 Add or retain fixture: open R2D + already-merged PR contained in base → already-integrated without second merge (any-state path).
- [ ] 2.5 Prove the closed+merged+R2D test fails against current open-only behavior before the fix (or document equivalent bite), then passes with the fix.

## 3. Mirror, CI, and docs touch

- [ ] 3.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change.
- [ ] 3.2 Run `npm run ci` from repo root; fix failures until green.
- [ ] 3.3 If operator docs name the train already-integrated / blocker strings, update only the minimal prose that would otherwise lie (skip if unchanged).
