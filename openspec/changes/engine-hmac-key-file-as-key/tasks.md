## 1. Regression tests that bite current engine child env

- [x] 1.1 Add a co-located unit test (prefer `core/test/ship-end-candidate.test.ts`) that builds parent env with `PIPELINE_FRG_ATTESTATION_KEY` unset and `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty dummy file. Record attestor and ensure-tag child env from the in-engine spawn helpers. Assert the test **fails** against current `attestorChildEnv` (unsets `KEY_FILE` without loading) and current ensure-tag spawn (`uncredentialedPrepareEnv` deletes both) when a child records neither `KEY` nor `KEY_FILE`
- [x] 1.2 Extend that fixture so missing or empty `KEY`+`KEY_FILE` fails closed with `missing_attestor_credential` (or equivalent) and does not spawn HMAC verify. Verify the assertion exists before the helper is fixed
- [x] 1.3 Cover unreadable `KEY_FILE` (`unreadable_attestor_key_file`) and empty file (`missing_attestor_credential`). Verify those cases fail closed and do not spawn HMAC verify. Inject I/O. Do not start a live tag, network, git, or subprocess ship

## 2. Shared engine presentation helper

- [x] 2.1 Add one engine helper that implements the Tugboat five-branch recipe against a parent env copy: inherit `KEY` and unset `KEY_FILE`; else fail closed on missing/empty/unreadable `KEY_FILE`; else set `KEY` from the file body and unset `KEY_FILE`. Do not mutate the parent env. Verify task 1.1 now passes when attestor and ensure-tag spawn use that helper
- [x] 2.2 When `KEY` is already set, inherit it and still unset `KEY_FILE`. Verify both HMAC children record `KEY=<inline>` and `KEY_FILE` unset
- [x] 2.3 Keep `uncredentialedPrepareEnv` for prepare. Verify prepare child env still has both `KEY` and `KEY_FILE` unset when the parent has `KEY_FILE` set. Do not persist the key body in ship state, finish JSON, request JSON, or logs

## 3. Wire HMAC-verify children

- [x] 3.1 Point in-engine `pipeline ship` attestor spawn at the presentation helper instead of `attestorChildEnv` as a KEY-only inherit. Verify attestor child env is `KEY=<dummy>` and `KEY_FILE` unset in the task 1.1 fixture
- [x] 3.2 Point in-engine `pipeline ship` ensure-tag spawn at the presentation helper. Ensure-tag SHALL NOT use `uncredentialedPrepareEnv`. Verify ensure-tag child env is `KEY=<dummy>` and `KEY_FILE` unset in the task 1.1 fixture
- [x] 3.3 Apply the same helper at `factory-gate --from-run` and `release ensure-tag` HMAC mint/verify entry so a host with only `KEY_FILE` can HMAC-verify without a Tugboat wrap. Verify a unit test with `KEY` unset and readable non-empty `KEY_FILE` no longer fails with `PIPELINE_FRG_ATTESTATION_KEY is required to verify integrity.attestation` before presentation. HMAC mint/verify still authenticates with `KEY` after presentation

## 4. Docs and gate

- [x] 4.1 Update `docs/factory-reliability-gate-runbook.md` so KEY_FILE presentation is engine (or in-engine ship composer) duty, not Tugboat-only. Keep HMAC required. Keep Actions on repo secret `KEY`. Verify the runbook no longer says the engine reads `KEY` only while hosts keep a file
- [x] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 4.3 Run `openspec validate engine-hmac-key-file-as-key` and `npm run ci` from the repo root. Verify both are green. Do not commit gitignored `.agent-pipeline/frg/latest.json`. Do not add `--skip-frg` as the default ship path. Do not put the key body in SKILL.md
