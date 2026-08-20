## 1. Local ensure-tag HMAC binding

- [ ] 1.1 Keep `pipeline release ensure-tag` / `ensureAnnotatedReleaseTag` as the only tag mutator. Do not add `git tag` to Tugboat or tag create to `release finish`
- [ ] 1.2 Make on-disk `validateFrgEvidenceFileForTag` fail closed when `latest.json` is missing, `pass` is not true, or HMAC is invalid (reuse the shared `--validate-tag` path)
- [ ] 1.3 Fail closed when HMAC `candidate_git_sha` is not this ship's FRG-bound packed candidate. Do not require packed candidate SHA to equal the merge commit. Do not rewrite `latest.json`
- [ ] 1.4 Keep the existing merge-OID proof (`assertEnsureTagOidIsMergedRelease`). Tag the peeled merge commit only

## 2. Tugboat compose

- [ ] 2.1 After `release finish` success, parse 40-hex `mergeCommitOid` from `$RUN_DIR/release-finish.json`. Fail closed if it is missing
- [ ] 2.2 Invoke `"${SHIP_END_CLI[@]}" release ensure-tag "$version" "$merge_oid"` before `wait-release`. Keep train and `engine-promote` on process-start `$PIPELINE`
- [ ] 2.3 Leave `wait-release` as `gh release view vX.Y.Z`. Do not add `git tag` or `gh release create`
- [ ] 2.4 Confirm finish JSON already emits `mergeCommitOid` (`gh pr view --json mergeCommit`). Do not invent a second field name in the shell

## 3. Auto-tag gitignored FRG

- [ ] 3.1 In `.github/workflows/auto-tag-release.yml`, when `.agent-pipeline/frg/` (or the version `latest.json` path) is gitignored and the tree file is absent, exit 0 without tagging. Do not fail the job
- [ ] 3.2 Keep the existing remote-tag-exists successful no-op **before** FRG verify
- [ ] 3.3 When FRG is not gitignored, keep today's fail-closed `--validate-tag` against the tree
- [ ] 3.4 Do not tag from Actions without HMAC. Do not commit `latest.json`. Do not add `--skip-frg`

## 4. Tests

- [ ] 4.1 Regression: Tugboat composer/source check fails if pack-done + merged release goes to `wait-release` without candidate `release ensure-tag` while on-disk HMAC evidence is eligible and the tree has no `latest.json`
- [ ] 4.2 Regression: auto-tag workflow/unit test fails if the gitignored missing-tree-file case still exits non-zero
- [ ] 4.3 Unit: `release ensure-tag` / `ensureAnnotatedReleaseTag` does not push when disk HMAC is missing, `pass: false`, merge OID is wrong, or `candidate_git_sha` is not the packed candidate
- [ ] 4.4 Unit: eligible on-disk HMAC plus correct merge OID creates/pushes the annotated tag (existing git/validateFrg seams). Packed candidate SHA MAY differ from the merge OID
- [ ] 4.5 Tugboat still has no `git tag` / `gh release create`. Playbook remains a thin launcher to repo Tugboat
- [ ] 4.6 Tests inject I/O or inspect source/workflow. They do not push real tags, call GitHub, or run a live ship

## 5. Docs and gate

- [ ] 5.1 Update `docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, `docs/concepts.md`, and the FRG runbook: local `release ensure-tag` owns `vX.Y.Z` when FRG is gitignored; auto-tag must not stall the ship; finish still does not tag
- [ ] 5.2 Flip any drift-guard that still asserts auto-tag fail-closes on missing tree `latest.json` without a gitignore exception, or that Tugboat never invokes tag-create
- [ ] 5.3 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 5.4 Run `openspec validate ship-tag-from-on-disk-hmac` and `npm run ci` from the repo root. Fix failures until green
