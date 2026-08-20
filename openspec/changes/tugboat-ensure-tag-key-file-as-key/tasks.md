## 1. Regression test that bites the 1.39.6 helper

- [ ] 1.1 Add a co-located test in `core/test/tugboat.test.ts` that extracts `invoke_release_ensure_tag` and sibling `invoke_frg_pack_attestor` via `extractNamedFn` from `examples/supervisor/shell/tugboat.sh`. With `PIPELINE_FRG_ATTESTATION_KEY` unset and `PIPELINE_FRG_ATTESTATION_KEY_FILE` set to a readable non-empty dummy file, use the same `writeFakePipeline` env recorder as the attestor `#1133` test. Assert ensure-tag child env `KEY=<dummy body>` and `KEY_FILE_UNSET`. Verify the test **fails** against current `invoke_release_ensure_tag` when the child records neither `KEY` nor `KEY_FILE`
- [ ] 1.2 Extend that extract fixture (or add a sibling) so missing/empty `KEY`+`KEY_FILE` fails closed with `missing_attestor_credential` (or equivalent) and does not spawn `release ensure-tag`. Verify the assertion exists before the helper is fixed
- [ ] 1.3 Cover unreadable `KEY_FILE` (`unreadable_attestor_key_file`) and empty file (`missing_attestor_credential`). Verify those cases fail closed and do not spawn `release ensure-tag`

## 2. Ensure-tag credential mapping

- [ ] 2.1 In `examples/supervisor/shell/tugboat.sh` `invoke_release_ensure_tag`, apply the attestor KEY_FILE→KEY recipe before the existing `"${SHIP_END_CLI[@]}" release ensure-tag …` spawn: inherit `KEY` + `env -u KEY_FILE`; else fail closed on missing/empty/unreadable `KEY_FILE`; else `KEY="$(cat -- "$KEY_FILE")"` + `env -u KEY_FILE`. Keep argv (`version`, merge OID, `--packed-candidate`, `--repo-path`) unchanged. Verify task 1.1 now passes
- [ ] 2.2 When `KEY` is already set, inherit it and still unset `KEY_FILE` in the ensure-tag child. Verify with `writeFakePipeline` that child env is `KEY=<inline>` and `KEY_FILE_UNSET`
- [ ] 2.3 Do not persist the key body in `state.json`, finish JSON, or ship logs. Do not unset `KEY`/`KEY_FILE` in the Tugboat parent. Do not edit `frg-pack-helpers.sh` unless that helper is shared (ensure-tag is tugboat-only). Verify `write_state` still has no `PIPELINE_FRG_ATTESTATION_KEY` and existing `#1149` / `#1163` argv tests still pass

## 3. Gate

- [ ] 3.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 3.2 Run `openspec validate tugboat-ensure-tag-key-file-as-key` and `npm run ci` from the repo root. Verify both are green. Do not commit gitignored `.agent-pipeline/frg/latest.json`. Do not add `--skip-frg` as the default ship path
