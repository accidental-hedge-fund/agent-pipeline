## Why

`.agent-pipeline/frg/` is gitignored (#1127). GitHub Actions `auto-tag-release` cannot read HMAC `latest.json` from the merged tree, so it fail-closes (`FRG evidence is not release-eligible … missing at …/latest.json`). Buzz Tugboat only polls `gh release view` after `pipeline release finish`. `release finish` does not tag. `ensureAnnotatedReleaseTag` exists only on in-engine `pipeline ship`. After HMAC pack and a merged release PR, no local path creates `vX.Y.Z`. 1.39.4 and 1.39.5 both needed a human `git tag`. That is not a durable ship.

## What Changes

- **Class law:** after a merged release PR, every ship-end composer SHALL invoke the existing candidate-engine tag helper (`pipeline release ensure-tag` / `ensureAnnotatedReleaseTag`) **before** publication wait. The helper SHALL read **on-disk** HMAC `latest.json`, not the git tree.
- **Tugboat:** after `release finish` and before `wait-release`, invoke candidate `release ensure-tag <X.Y.Z> <peeled-merge-oid>`. Tugboat SHALL still not shell `git tag` or `gh release create`.
- **Fail-closed tag create:** missing on-disk `latest.json`, `pass` not true, invalid HMAC, or a tag target that is not the peeled merge commit of that version's merged release PR SHALL fail closed and SHALL NOT push `vX.Y.Z`.
- **Auto-tag SHALL NOT block the ship when FRG is gitignored.** When `.agent-pipeline/frg/` is gitignored and tree-file `latest.json` is absent, auto-tag SHALL NOT exit non-zero. Local tag push is the source of truth. If `vX.Y.Z` already exists, auto-tag remains a successful no-op. Auto-tag SHALL NOT invent a skip-frg path and SHALL NOT tag a SHA that HMAC did not bind.
- **`wait-release` SHALL succeed** after that local tag plus GitHub Release (`release.yml` on the `v*` tag push) without a human `git tag`.
- **BREAKING** for Tugboat / playbook fixtures that treat pack-done + merged release + `gh release view` as enough, and for auto-tag fixtures that still fail closed on missing **tree** `latest.json` when `.agent-pipeline/frg/` is gitignored.

Non-goals: committing `latest.json` so Actions can see it; `--skip-frg` as the ship path; tagging a SHA that is not the peeled merge commit; tagging a SHA that HMAC did not bind as this ship's packed candidate; merging inside advance/loop.

## Acceptance criteria

- [ ] After Tugboat (or in-engine `pipeline ship`) reports pack-done and a merged release PR for `X.Y.Z`, the composer invokes candidate `pipeline release ensure-tag` (or `ensureAnnotatedReleaseTag`) with the peeled merge-commit OID **before** `wait-release` / publication wait.
- [ ] That tag helper creates and pushes annotated tag `vX.Y.Z` on the peeled merge commit when on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` is release-eligible (`pass: true`, valid HMAC) and bound to this ship's packed candidate.
- [ ] Tag create fails closed (no tag push) when on-disk HMAC `latest.json` is missing, `pass` is not true, HMAC is invalid, the supplied OID is not the peeled merge commit of that version's merged release PR, or `candidate_git_sha` is not this ship's FRG-bound packed candidate.
- [ ] Tugboat source still has no `git tag` and no `gh release create`. Tag mutation stays in the candidate engine helper.
- [ ] When `.agent-pipeline/frg/` is gitignored and the merged tree has no `latest.json`, `auto-tag-release` does not exit non-zero for missing tree-file FRG. If `vX.Y.Z` already exists, it remains a successful no-op. It does not create a tag without HMAC evidence.
- [ ] After the local tag push, `wait-release` (`gh release view vX.Y.Z`) succeeds once GitHub Release is published. No human `git tag` is required.
- [ ] A unit or composer test fails if Tugboat/finish reports pack-done + merged release and never invokes tag-create when the tree has no `latest.json` but on-disk HMAC evidence is eligible.
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

- **Tugboat:** `examples/supervisor/shell/tugboat.sh` gains a candidate `release ensure-tag` invoke after finish, using the merged PR merge-commit OID. `wait-release` stays `gh release view`.
- **Engine:** `ensureAnnotatedReleaseTag` / `runEnsureAnnotatedReleaseTagCli` in `core/scripts/stages/ship-adapter.ts` remain the tag mutators. They MUST validate on-disk HMAC `latest.json` (existing `validateFrgEvidenceFileForTag`). `release-finish.ts` stays merge-only.
- **Auto-tag:** `.github/workflows/auto-tag-release.yml` and `core/test/auto-tag-release-workflow.test.ts` change the gitignored-missing-tree-file case from fail-closed to non-blocking.
- **Tests:** Tugboat composer tests that currently forbid any tag path after pack; ship-adapter ensure-tag tests; auto-tag workflow drift guards. Inject I/O. No live tag push, network, or GitHub in unit tests.
- **Docs:** `docs/runbooks/ship-milestone.md`, `docs/supervisor.md`, `docs/concepts.md`, FRG runbook: local ensure-tag owns `vX.Y.Z` when FRG is gitignored; auto-tag must not stall the ship.
- **Does not:** commit `.agent-pipeline/frg/`; default `--skip-frg`; tag an unbound SHA; merge inside advance/loop; add a Tugboat `git tag` shell.
- **Depends on:** living `release ensure-tag` (#1115 / ship-coordinator), gitignored FRG (#1127), ship-end candidate engine (#1151), Tugboat FRG pack (#1039 / #1133).
- **Evidence:** auto-tag-release run 32197953276 (1.39.4) missing tree `latest.json`; Tugboat `wait-release` only `gh release view`; `release-finish.ts` "this command does not tag"; 1.39.5 on-disk HMAC `latest.json` with no `v1.39.5` tag and no GitHub Release.
