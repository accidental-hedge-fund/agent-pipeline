## 1. Tugboat FRG pack phase

- [x] 1.1 Add Tugboat `--skip-frg` / `--skip-frg-reason` flags and `TUGBOAT_SKIP_FRG` / `TUGBOAT_SKIP_FRG_REASON` env. Skip without a non-empty reason fails closed before ship mutation
- [x] 1.2 After train complete/resume, on the default path, write a secret-free `factory_release_prepare_request` under the ship run dir (schema_version 1, bare target_version, candidate SHA, manifest identity). No credentials or caller-authored pass
- [x] 1.3 Invoke `pipeline factory-release prepare --request <abs.json> --json` and re-invoke the unchanged request until pack-done (`awaiting_frg_attestation`, this version `latest.json` `pass: true`, or `complete` with an open release PR) or pack-fail
- [x] 1.4 On pack-fail (failed/missing FRG, `pass: false` after terminal score, wait budget exhausted on `in_progress`) fail the `frg-pack` phase with captured reason and do not call `pipeline release`
- [x] 1.5 On valid escape, omit the pack phase, pass `--skip-frg` to release and promote, and write the reason into ship state or log

## 2. Drop default --skip-frg

- [x] 2.1 Change default Tugboat release argv to `release "$version" --no-edit` with no `--skip-frg`
- [x] 2.2 Change default Tugboat promote argv to `engine-promote --for "$version" --host "$ENGINE_PROMOTE_HOST" --json` with no `--skip-frg`
- [x] 2.3 Change default playbook release and promote argv the same way. If the playbook stays installed, compose the same prepare request/re-invoke before release or let release fail closed

## 3. Tests

- [x] 3.1 Composer test: default `ship_one` body has no `--skip-frg` on release or promote and does compose `factory-release prepare` (or the documented #1037 sequence). Prove the test fails against the current keep-skip source
- [x] 3.2 Composer or unit test: escape with a non-empty reason omits pack and still passes `--skip-frg` to release and promote. Skip without reason does not skip
- [x] 3.3 Flip doctor / playbook source assertions that currently require default `--skip-frg` (`core/test/doctor.test.ts`, `core/test/engine-promote.test.ts`, and any sibling)
- [x] 3.4 Tests inject I/O or inspect source/fixtures. They start no live pack, network, git, or subprocess ship
- [x] 3.5 Regression: `write_factory_release_request` binds `origin/<base>` remote tip (injected fake git), not local `HEAD`, and fail-closes when the remote tip is missing
- [x] 3.6 Review-2: `classify_frg_pack_tick` fails on `latest.json` `pass: false` before awaiting/complete, and `complete` is done only with a verified open release PR
- [x] 3.7 Review-2: request writer uses `.github/pipeline.yml` / `TUGBOAT_BASE_BRANCH`, preserves slash names, and does not guess `origin/HEAD`
- [x] 3.8 Review-3: request writer binds quoted `"base_branch"` keys and unquoted `deploy#blue` names; it does not default those forms to `main` or truncate at `#`
- [x] 3.9 Review-2: `classify_frg_pack_tick` accepts `pass: true` only when latest.json records the request version and candidate SHA; a stale SHA stays retry

## 4. Docs and Hermes skill

- [x] 4.1 Update `examples/supervisor/hermes/SKILL.md` so the default ship sequence is train → FRG pack → release (no skip) → finish → promote. Document skip as escape with a logged reason only
- [x] 4.2 Update `docs/runbooks/ship-milestone.md`: phase list includes frg-pack; remove "FRG is not part of thin ship / optional advisory"
- [x] 4.3 Update `docs/factory-reliability-gate-runbook.md` so the skip-frg restore paragraph records that this child dropped the Tugboat default after the #1038 honest-pass check

## 5. Thinness, packaging, gate

- [x] 5.1 Confirm Tugboat still has no grant-factory, `pipeline ship ` product path, attestation signing, or merge/tag/pin/install in the pack phase
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.3 Run `openspec validate tugboat-frg-pack-drop-skip-frg` and `npm run ci` from the repo root. Fix failures until green
