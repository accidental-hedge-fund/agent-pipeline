## 1. Shared live-loop wait decision

- [ ] 1.1 Add a wait-continue vs wait-fail decision that takes tick verdict, bound-loop liveness (lock.json pid alive or ledger not terminal), and the numeric attempt cap. `in_progress` + live SHALL be continue even when attempt == cap
- [ ] 1.2 Add a liveness probe for prepare `loop_run_id`: live when durable run `lock.json` pid is alive or the bound ledger / events are not terminal; not live when lock pid is dead or missing and ledger is terminal or missing
- [ ] 1.3 Keep the helper in sync between `tugboat.sh` and `frg-pack-helpers.sh` if the decision or probe is shared. Do not start a live pack in tests

## 2. Tugboat wait loop and heartbeat

- [ ] 2.1 Change the Tugboat FRG pack `for` loop so wait-budget expiry is not pack-fail while the bound loop is live. Keep re-invoking the same `factory-release prepare` request. Do not kill the pack loop
- [ ] 2.2 Heartbeat each live wait tick: `write_state "frg-pack" "running"` with updated `updated_at` and a wait detail. Log a heartbeat line
- [ ] 2.3 Keep the numeric `FRG_WAIT_*` cap only for the not-live case. Do not copy `RELEASE_WAIT_*` as the live-loop stop. Leave CI wait unchanged
- [ ] 2.4 Keep real pack-fail fail-closed (failed or missing FRG, `pass: false` after a terminal score, attestor child failure). Do not add `--skip-frg` as the default

## 3. In-engine ship-adapter wait

- [ ] 3.1 Apply the same live-loop wait law in `core/scripts/stages/ship-adapter.ts`. A 120×10s cap plus "retry the same ship command to resume" SHALL NOT fail the ship while the bound loop is live
- [ ] 3.2 Keep the in-engine ship ledger FRG phase running on each live wait tick. Do not return at the attestation checkpoint. Do not raise the implementer 2400s cap

## 4. Tests

- [ ] 4.1 Regression: `in_progress` plus a live bound loop after N short sleeps at cap N is continue, not terminal fail. Prove the test fails against current Tugboat wait-fail
- [ ] 4.2 Regression: `state.json` stays `frg-pack` / `running` on a live wait tick (heartbeat). Failed wait message `FRG pack still in_progress within wait budget` SHALL NOT fire while live
- [ ] 4.3 Regression: `in_progress` plus not-live bound loop at cap still fails closed
- [ ] 4.4 Regression: ship-adapter live `in_progress` at cap is continue, not the resume-to-retry throw
- [ ] 4.5 Sync test: Tugboat and `frg-pack-helpers.sh` wait helpers still match when shared
- [ ] 4.6 Tests inject I/O or inspect source/fixtures. They start no live pack, network, git, or subprocess ship

## 5. Docs, packaging, gate

- [ ] 5.1 Update `docs/runbooks/ship-milestone.md` (and FRG / supervisor ship text if needed): FRG pack wait is wait-until-terminal while the bound loop is live; 20-minute CI copy is not pack-fail; re-detach is not the resume path
- [ ] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 5.3 Run `openspec validate frg-pack-wait-outlive-bound-loop` and `npm run ci` from the repo root. Fix failures until green
