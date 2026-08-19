## 1. Prepare child env isolation

- [x] 1.1 Invoke `pipeline factory-release prepare` from Tugboat so the prepare child has `PIPELINE_FRG_ATTESTATION_KEY` and `PIPELINE_FRG_ATTESTATION_KEY_FILE` unset (`env -u` or equivalent). Do not unset those names in the Tugboat parent
- [x] 1.2 Apply the same uncredentialed prepare child to `pipeline-ship-playbook.sh` and shared `frg-pack-helpers.sh` so the installed playbook copy cannot inherit supervisor `KEY_FILE`
- [x] 1.3 Confirm Tugboat still does not write request JSON with credential keys and does not persist the key body in `state.json`

## 2. Out-of-process attestor compose

- [x] 2.1 When prepare returns `awaiting_frg_attestation` (or unsigned eligible artifacts exist and bound `latest.json` `pass: true` is missing), invoke `pipeline factory-gate --for <X.Y.Z> --from-run <loop>` in a child other than prepare. Use bound `loop_run_id` / `frg.loop_run_id`. Do not pass `--observations`
- [x] 2.2 Give the attestor child the producer credential: inherit `PIPELINE_FRG_ATTESTATION_KEY` when set; when only `PIPELINE_FRG_ATTESTATION_KEY_FILE` is set, present that file as `PIPELINE_FRG_ATTESTATION_KEY` in the attestor child only
- [x] 2.3 On attestor child failure or missing producer credential after unsigned artifacts exist, fail the `frg-pack` phase with a named reason. Do not pass `--skip-frg`. Do not treat pack as done
- [x] 2.4 Mirror 2.1–2.3 in the playbook / `frg-pack-helpers.sh` so helpers stay in sync with Tugboat

## 3. Pack-done classifier

- [x] 3.1 Change `classify_frg_pack_tick` so `awaiting_frg_attestation` without matching `latest.json` `pass: true` is not `done` (use `attest` or equivalent). Keep `pass: false` as fail-before-success. Keep complete-without-open-PR as fail
- [x] 3.2 After the attestor child exits, re-read `latest.json` and require bound `pass: true` (version + candidate SHA, and `action_id` when recorded) before pack-done
- [x] 3.3 Keep helper text in sync between `tugboat.sh` and `frg-pack-helpers.sh` for `write_factory_release_request`, `classify_frg_pack_tick`, and the new attestor compose

## 4. Tests

- [x] 4.1 Regression: fail if prepare is invoked with `KEY` or `KEY_FILE` set in that child. Prove the test fails against current Tugboat (inherited env)
- [x] 4.2 Regression: `classify_frg_pack_tick` must not print `done` for `awaiting_frg_attestation` when `latest.json` is missing or not bound `pass: true`. Prove it fails against the current `done` branch
- [x] 4.3 Composer test: pack phase composes `factory-gate --from-run` and still does not merge/tag/promote/install, invent `pass: true`, or write the key body into `state.json`. Flip the old assertion that forbade all attestor markers
- [x] 4.4 Sync test: Tugboat and `frg-pack-helpers.sh` pack helpers (including attestor compose) still match
- [x] 4.5 Tests inject I/O or inspect source/fixtures. They start no live pack, network, git, or subprocess ship

## 5. Docs, packaging, gate

- [x] 5.1 Update `docs/runbooks/ship-milestone.md` pack-done paragraph: bound `latest.json` `pass: true`; `awaiting_frg_attestation` is not pack-done; prepare is uncredentialed; attestor is `factory-gate --from-run` in a separate process
- [x] 5.2 Update Hermes `pipeline-supervisor` skill / FRG runbook ship-path text if it still lists `awaiting_frg_attestation` as pack-done
- [x] 5.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.4 Run `openspec validate tugboat-frg-pack-sign-outside-prepare` and `npm run ci` from the repo root. Fix failures until green
