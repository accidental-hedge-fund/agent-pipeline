## Why

`.agent-pipeline/frg/` is gitignored (#1127). GitHub Actions `auto-tag-release` cannot read HMAC `latest.json` from the merged tree, so it fail-closes (`FRG evidence is not release-eligible … missing at …/latest.json`). Buzz Tugboat only polls `gh release view` after `pipeline release finish`. `release finish` does not tag. `ensureAnnotatedReleaseTag` exists only on in-engine `pipeline ship`. After HMAC pack and a merged release PR, no local path creates `vX.Y.Z`. 1.39.4 and 1.39.5 both needed a human `git tag`. That is not a durable ship.

## What Changes

- **Class law:** after a merged release PR, every ship-end composer SHALL invoke the existing candidate-engine tag helper (`pipeline release ensure-tag` / `ensureAnnotatedReleaseTag`) **before** publication wait. The helper SHALL read **on-disk** HMAC `latest.json`, not the git tree.
- **Tugboat:** after `release finish` and before `wait-release`, parse finish JSON `mergeCommitOid`, reject missing/non-40-hex, and invoke recorded candidate `release ensure-tag <X.Y.Z> <mergeOid> --packed-candidate <integrated_candidate.git_sha>`. Tugboat SHALL still not shell `git tag` or `gh release create`.
- **Fail-closed tag create:** missing on-disk `latest.json`, `pass` not true, invalid HMAC, a tag target that is not the peeled merge commit, or HMAC `candidate_git_sha` that is not this ship's independent packed SHA SHALL fail closed and SHALL NOT push `vX.Y.Z`. Packed SHA MAY differ from the merge commit.
- **Independent packed-candidate proof:** `--packed-candidate` comes from factory-release request `integrated_candidate.git_sha` (Tugboat) or `ShipTrainEvidence.integrated_head_oid` (in-engine). HMAC `latest.json` is compared to that SHA. HMAC is not the authority for "this ship."
- **Existing tag / race:** success only for an annotated `vX.Y.Z` whose peeled commit equals the merge. Never force-update or delete. Concurrent push re-observes origin and succeeds only if that tag is correct.
- **Auto-tag SHALL NOT block the ship when FRG is gitignored.** Skip tagging only when exact `.agent-pipeline/frg/<X.Y.Z>/latest.json` is absent **and** `git check-ignore --quiet -- "$path"` is true. That branch does not create a tag and MUST gate notes, tag-create, and docs-refresh so the job still exits 0. Existing-but-invalid or non-ignored-missing evidence keeps `--validate-tag` fail-close. If `vX.Y.Z` already exists, auto-tag remains a successful no-op. Auto-tag SHALL NOT invent a skip-frg path.
- **`wait-release` SHALL succeed** after that local tag plus GitHub Release (`release.yml` on the `v*` tag push) without a human `git tag`.
- **BREAKING** for Tugboat / playbook fixtures that treat pack-done + merged release + `gh release view` as enough, and for auto-tag fixtures that still fail closed on missing **tree** `latest.json` when `.agent-pipeline/frg/` is gitignored.

Non-goals: committing `latest.json` so Actions can see it; `--skip-frg` as the ship path; tagging a SHA that is not the peeled merge commit; tagging a SHA that HMAC did not bind as this ship's packed candidate; merging inside advance/loop.

## Acceptance criteria

- [ ] After Tugboat (or in-engine `pipeline ship`) reports pack-done and a merged release PR for `X.Y.Z`, the composer invokes candidate `pipeline release ensure-tag` (or `ensureAnnotatedReleaseTag`) with the peeled merge-commit OID and `--packed-candidate` **before** `wait-release` / publication wait.
- [ ] That tag helper creates and pushes annotated tag `vX.Y.Z` on the peeled merge commit when on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` is release-eligible (`pass: true`, valid HMAC) and HMAC `candidate_git_sha` equals the independent packed SHA (`integrated_candidate.git_sha` / `integrated_head_oid`).
- [ ] Tag create fails closed (no tag push) when on-disk HMAC `latest.json` is missing, `pass` is not true, HMAC is invalid, the supplied OID is not the peeled merge commit of that version's merged release PR, `--packed-candidate` is missing, or HMAC `candidate_git_sha` is not that packed SHA.
- [ ] Tugboat source still has no `git tag` and no `gh release create`. Tag mutation stays in the candidate engine helper. `release finish` stays tag-free.
- [ ] When exact `.agent-pipeline/frg/<X.Y.Z>/latest.json` is absent and gitignored, `auto-tag-release` exits 0 without creating a tag and without failing docs-refresh. If `vX.Y.Z` already exists, it remains a successful no-op. Non-ignored missing or existing-invalid evidence still fail-closes.
- [ ] After the local tag push, `wait-release` (`gh release view vX.Y.Z`) succeeds once GitHub Release is published. No human `git tag` is required. Ensure-tag failure prevents `wait-release`.
- [ ] A behavioral Tugboat test fails if pack-done + merged release never invokes tag-create when the tree has no `latest.json` but on-disk HMAC evidence is eligible.
- [ ] A unit or workflow test fails if auto-tag still fail-closes solely because gitignored tree-file `latest.json` is absent.
- [ ] `--skip-frg` remains an operator escape with a logged reason. It is not the default. The change does not commit FRG evidence.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `ship-on-disk-frg-tag`: Shared class law that post-merge annotated tag create reads on-disk HMAC `latest.json`, runs on every ship-end composer through `pipeline release ensure-tag`, fail-closes on missing or unbound evidence, and treats local tag push as the source of truth when FRG is gitignored so `wait-release` can complete.

### Modified Capabilities

- `tugboat-thin-ship`: After `release finish`, Tugboat SHALL invoke candidate `release ensure-tag` before `wait-release`. Phase order gains that step. Tugboat SHALL still not shell `git tag` / `gh release create`.
- `ship-end-candidate-engine`: Ship-end composers SHALL invoke candidate `release ensure-tag` after merge. The existing "Tugboat SHALL NOT invoke `git tag`" rule stays. It does not excuse skipping `release ensure-tag`.
- `ship-coordinator`: Publication wait SHALL keep calling `ensureAnnotatedReleaseTag` / `release ensure-tag` against **on-disk** HMAC `latest.json` bound to the peeled merge commit and packed candidate. Missing disk evidence SHALL fail closed.
- `release-auto-tag-on-merge`: When `.agent-pipeline/frg/` is gitignored, missing tree-file `latest.json` SHALL NOT fail the auto-tag job. Local tag push is the source of truth. Existing tag-already-exists no-op stays.
- `factory-reliability-gate`: Shared `--validate-tag` for the **local** tag helper still fail-closes on missing on-disk `latest.json`. Auto-tag SHALL NOT require a committed / force-added tree copy of gitignored FRG. The "attach evidence so auto-tag can see it" attachment rule is superseded for the gitignored path.
- `release-sub-command`: `pipeline release finish` remains merge-authorized and does not itself tag. Post-merge tag create is `pipeline release ensure-tag`. Docs that say "workflows tag; finish never tags" SHALL name the local ensure-tag path as the ship-end tag owner when FRG is gitignored.
- `supervisor-ship-playbook`: The thin launcher still execs repo Tugboat. The playbook SHALL NOT keep a second compose that waits for GitHub Release without invoking `release ensure-tag`.

## Impact

- **Tugboat:** `examples/supervisor/shell/tugboat.sh` gains a candidate `release ensure-tag` invoke after finish, using finish JSON `mergeCommitOid` and request `integrated_candidate.git_sha`. `wait-release` stays `gh release view`.
- **Engine:** `ensureAnnotatedReleaseTag` / `runEnsureAnnotatedReleaseTagCli` in `core/scripts/stages/ship-adapter.ts` remain the tag mutators. They MUST validate on-disk HMAC `latest.json` and compare HMAC candidate SHA to `--packed-candidate`. `release-finish.ts` stays merge-only.
- **Auto-tag:** `.github/workflows/auto-tag-release.yml` and `core/test/auto-tag-release-workflow.test.ts` change the exact-path gitignored-absent case from fail-closed to a non-tagging successful skip that also gates notes, tag-create, and docs-refresh.
- **Tests:** Behavioral Tugboat PATH-stub for post-finish phase order; ship-adapter ensure-tag packed-candidate and race cases; auto-tag ignored-absent vs non-ignored-absent. Inject I/O. No live tag push, network, or GitHub in unit tests.
- **Docs:** `docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, `docs/concepts.md`, FRG runbook: local ensure-tag owns `vX.Y.Z` when FRG is gitignored; auto-tag must not stall the ship.
- **Does not:** commit `.agent-pipeline/frg/`; default `--skip-frg`; tag an unbound SHA; merge inside advance/loop; add a Tugboat `git tag` shell.
- **Depends on (already in this tree):** living two-arg `release ensure-tag`, on-disk `--validate-tag`, finish `mergeCommitOid`, Tugboat `SHIP_END_CLI` / `integrated_candidate.git_sha`, gitignored FRG. **This change adds:** `--packed-candidate` proof, Tugboat invoke, auto-tag skip-gating, race re-observe.
- **Evidence:** auto-tag-release run 32197953276 (1.39.4) missing tree `latest.json`; Tugboat `wait-release` only `gh release view`; `release-finish.ts` "this command does not tag"; 1.39.5 on-disk HMAC `latest.json` with no `v1.39.5` tag and no GitHub Release.
