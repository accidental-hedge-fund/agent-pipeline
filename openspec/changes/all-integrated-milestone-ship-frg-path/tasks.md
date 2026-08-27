## 1. Shared freeze listing

- [ ] 1.1 Change `pipeline train --milestone` listing to state `all` (or equivalent) and keep freeze-eligible issues: open non-backlog plus closed `pipeline:ready-to-deploy`. Verify an injected all-closed R2D fixture no longer throws `has no open issues`
- [ ] 1.2 Change in-engine ship `planTrain` freeze to the same freeze-eligible set. Verify it no longer throws `no open issues to freeze` when every item is closed R2D
- [ ] 1.3 Keep existing 200-issue discovery limit. Verify a true empty freeze-eligible milestone still fails closed with a freeze-eligible (not open-only) error
- [ ] 1.4 Do not add a second already-integrated classifier at freeze time. Verify closed R2D without a merged contained PR still hits train merge-mode fail-closed law

## 2. Mixed and already-integrated train path

- [ ] 2.1 Include already-integrated closed R2D items in the same ship / train `--merge` work list as open mergeable R2D items. Verify the mixed fixture merges the open PR and records the closed item `already-integrated` in one run
- [ ] 2.2 Reuse existing `already-integrated` reconciliation. Verify no second merge mutation for the integrated item

## 3. Freeze regression tests

- [ ] 3.1 Add a hermetic test that fails if freeze / train milestone listing rejects an all-closed+merged R2D milestone. Prove it fails on current open-only listing
- [ ] 3.2 Add a hermetic mixed-plan test that fails if the already-integrated item is omitted or the open item is not offered to merge. Prove it bites
- [ ] 3.3 Inject deps. Make no real network, git, or subprocess calls in these tests

## 4. FRG-missing diagnostics

- [ ] 4.1 Share one missing-FRG diagnostic (or helper) used by `requireFrgPassForRelease`, `factory-gate` missing-`--from-run` usage, and ship FRG converge. Verify each names `pipeline loop --label factory-gate --profile claude` and `pipeline factory-gate --for <v> --from-run`
- [ ] 4.2 Keep `factory-release prepare` as an optional additional line on the ship post-pilot path. Verify it does not replace the loop + profile + `--from-run` commands
- [ ] 4.3 If `--skip-frg` is mentioned, put it last and label it an escape. Verify it is not the first or only named recovery and is not implied for a non-claude profile
- [ ] 4.4 Do not auto-run the pack loop from ship or release. Do not change native-`/goal` attestation defaults. Verify skip still writes a non-production `no-frg-*` pin

## 5. FRG diagnostic regression tests

- [ ] 5.1 Add a hermetic test that fails if the release missing-pass diagnostic omits the pack-loop command, `--profile claude`, or `--from-run`. Prove it fails on the current scorer-only text
- [ ] 5.2 Add a hermetic test that fails if `factory-gate` missing-`--from-run` usage omits the pack-loop command or `--profile claude`. Prove it bites
- [ ] 5.3 Cover the ship missing-FRG diagnostic with the same assertions (helper unit test is enough if ship uses the helper). Inject deps; no real I/O

## 6. Docs and packaging

- [ ] 6.1 Update `docs/factory-reliability-gate-runbook.md`: all-integrated ship freeze records `already-integrated` and proceeds; missing FRG is recovered with `pipeline loop --label factory-gate --profile claude` then `factory-gate --for --from-run`. `--skip-frg` stays an escape, not the default
- [ ] 6.2 Update supervisor ship text (`docs/supervisor.md` and/or `docs/runbooks/ship-milestone.md`) with the same freeze path and pack-loop profile. Verify the text does not present skip as the implied non-claude path
- [ ] 6.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 6.4 Run `openspec validate all-integrated-milestone-ship-frg-path` and `npm run ci` from the repo root. Fix failures until green
