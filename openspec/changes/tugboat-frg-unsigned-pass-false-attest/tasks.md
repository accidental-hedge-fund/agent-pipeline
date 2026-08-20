## 1. Structural eligibility vs attested pass

- [x] 1.1 Make HMAC-optional structural eligibility ignore attested `pass: false` when HMAC is absent. Keep scoreboard, composition, required scenarios, pack id, and provenance checks
- [x] 1.2 Keep unsigned `latest.json` as `pass: false`. Do not invent `pass: true` without HMAC
- [x] 1.3 Prove a regression test fails today when a structurally eligible unsigned score is treated as `frg_not_eligible` solely because `pass` is false

## 2. factory-release prepare status mapping

- [x] 2.1 Return `status: "awaiting_frg_attestation"` with closed unsigned artifacts and bound `loop_run_id` when the bound pack is terminal, structurally eligible, and HMAC is omitted
- [x] 2.2 Do not return `status: "failed"` or `defect_class: "frg_not_eligible"` for omitted HMAC only. Do not persist that failed checkpoint
- [x] 2.3 Re-observe a prior omitted-HMAC `failed` checkpoint for the unchanged request as `awaiting_frg_attestation` when the pack is still structurally eligible
- [x] 2.4 Keep real ineligible scores as `frg_not_eligible` / failed (composition missing, required scenario fail, wrong pack, engine-class over threshold)

## 3. Tugboat and playbook classify

- [x] 3.1 Change `classify_frg_pack_tick` so bound `pass: true` is done first, then `awaiting_frg_attestation` / unsigned eligible artifacts (including omitted-HMAC `pass: false`) are `attest`, then real ineligible `pass: false` is `fail`
- [x] 3.2 Keep `tugboat.sh` and `frg-pack-helpers.sh` pack helpers in sync
- [x] 3.3 Keep the attestor child as `factory-gate --for <X.Y.Z> --from-run <bound-loop>` with KEY present and KEY_FILE unset. Keep prepare KEY/KEY_FILE unset. Do not persist the key body in `state.json`

## 4. In-engine ship

- [x] 4.1 Apply the same omitted-HMAC class on `pipeline ship`: prepare `failed` / `frg_not_eligible` for omitted HMAC only SHALL NOT stop the ship. Attest then re-invoke prepare
- [x] 4.2 Do not expand ship-adapter to re-parse `latest.json` unless prepare status mapping is insufficient

## 5. Tests

- [x] 5.1 Regression: unsigned eligible `latest.json` `pass: false` plus prepare `awaiting_frg_attestation` classifies `attest`, not `fail`. Prove the test fails against current Tugboat classify
- [x] 5.2 Regression: prepare reports `awaiting_frg_attestation`, not `failed` / `frg_not_eligible`, when HMAC is the only missing piece
- [x] 5.3 Regression: real ineligible `pass: false` (composition missing or required scenario fail) still classifies `fail` and prepare still returns `frg_not_eligible`
- [x] 5.4 Regression: pack-done still requires bound `latest.json` `pass: true`. `awaiting` alone is not done
- [x] 5.5 Sync test: Tugboat and `frg-pack-helpers.sh` classify helpers still match
- [x] 5.6 Tests inject I/O or inspect source/fixtures. They start no live pack, network, git, or subprocess ship

## 6. Docs, packaging, gate

- [x] 6.1 Update `docs/runbooks/ship-milestone.md` and FRG runbook if they still treat unsigned `pass: false` as pack-fail
- [x] 6.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 6.3 Run `openspec validate tugboat-frg-unsigned-pass-false-attest` and `npm run ci` from the repo root. Fix failures until green
