## 1. Local ensure-tag HMAC binding

- [x] 1.1 Keep `pipeline release ensure-tag` / `ensureAnnotatedReleaseTag` as the only tag mutator. Do not add `git tag` to Tugboat or tag create to `release finish`
- [x] 1.2 Add required `--packed-candidate <40-hex>` to `pipeline release ensure-tag`. Fail closed if missing or not 40-hex. Keep positional `<version> <mergeOid>`. Update `shipEndLeafArgv("ensure-tag")` and in-engine spawn
- [x] 1.3 After `validateFrgEvidenceFileForTag`, compare HMAC `factory_release_binding.candidate_git_sha` (else `pack_provenance.candidate_git_sha`) to `--packed-candidate`. Do not compare packed SHA to the merge commit. Do not rewrite `latest.json`
- [x] 1.4 Keep merge-OID proof (`assertEnsureTagOidIsMergedRelease`). Peel with `git rev-parse --verify ${oid}^{commit}`. Tag the peeled merge commit only
- [x] 1.5 Existing-tag success only when annotated and peeled commit equals the merge. Lightweight or wrong-target tag fail-closes. Never force-update or delete
- [x] 1.6 On concurrent push failure, re-observe origin `refs/tags/vX.Y.Z` and succeed only if it is the correct annotated tag on the merge commit

## 2. Tugboat compose

- [x] 2.1 After `release finish` success, parse 40-hex `mergeCommitOid` from `$RUN_DIR/release-finish.json`. Fail closed if missing or not 40-hex. Do not enter `wait-release`
- [x] 2.2 Invoke `"${SHIP_END_CLI[@]}" release ensure-tag "$version" "$merge_oid" --packed-candidate "$SHIP_END_CANDIDATE_SHA"` (packed SHA from request `integrated_candidate.git_sha`). Treat non-zero as a failed ship before `wait-release`
- [x] 2.3 Leave `wait-release` as `gh release view vX.Y.Z`. Do not add `git tag` or `gh release create`
- [x] 2.4 Keep finish tag-free. Playbook stays `exec` of repo `tugboat.sh`. In-engine publication wait passes the same `--packed-candidate` from `release.candidate_head_oid`

## 3. Auto-tag gitignored FRG

- [x] 3.1 In `.github/workflows/auto-tag-release.yml`, skip `--validate-tag` and tagging only when exact `.agent-pipeline/frg/<X.Y.Z>/latest.json` is absent **and** `git check-ignore --quiet -- "$path"` is true. Set an output that gates notes and tag-create. Do not tag on that branch
- [x] 3.2 File exists (ignored or not): keep `--validate-tag`. Invalid / malformed / `pass: false` / invalid HMAC fail-closes. Missing and not ignored fail-closes
- [x] 3.3 Keep the existing remote-tag-exists successful no-op **before** FRG verify. Never force-update or delete
- [x] 3.4 When the skip output is set and the tag is not visible, docs refresh is a successful no-op (do not fail the job)
- [x] 3.5 Do not tag from Actions without HMAC. Do not commit `latest.json`. Do not add `--skip-frg`

## 4. Tests

- [x] 4.1 Behavioral Tugboat harness (PATH-stub / spied `SHIP_END_CLI`): pack-done + merged release + eligible on-disk HMAC + no tree `latest.json` + no `release ensure-tag` invoke fails. Prove the test bites on current compose
- [x] 4.2 Same harness: missing/malformed finish JSON fails before `gh release view`. Ensure-tag non-zero prevents `wait-release`
- [x] 4.3 Source/thinness: Tugboat has no `git tag` / `gh release create`. Playbook remains a thin launcher. Finish remains tag-free
- [x] 4.4 Auto-tag extracted FRG-step: ignored-absent exits 0 and does not tag; non-ignored-absent fail-closes; existing-invalid fail-closes even if ignored. Notes/tag `if:` does not run on skip. Prove current workflow fails the ignored-absent case
- [x] 4.5 Ensure-tag unit: packed SHA ≠ merge SHA still tags merge; wrong OID; missing / failed / invalid-HMAC / unbound disk evidence; correct vs lightweight vs wrong existing tag; concurrent correct vs wrong remote tag. Inject git/observe/validateFrg
- [x] 4.6 Tests inject I/O or inspect source/workflow. They do not push real tags, call GitHub, or run a live ship

## 5. Docs and gate

- [x] 5.1 Update `docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, `docs/concepts.md`, and the FRG runbook: local `release ensure-tag` owns `vX.Y.Z` when FRG is gitignored; auto-tag must not stall the ship; finish still does not tag
- [x] 5.2 Flip any drift-guard that still asserts auto-tag fail-closes on missing tree `latest.json` without the exact-path gitignore exception, or that Tugboat never invokes tag-create
- [x] 5.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.4 Run `openspec validate ship-tag-from-on-disk-hmac` and `npm run ci` from the repo root. Fix failures until green. Do not claim tester-suite pass until that command is green
