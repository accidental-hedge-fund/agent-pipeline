## Context

See `proposal.md` for why. Current law and code at this worktree (inspected, not assumed):

- `#1127` gitignores `.agent-pipeline/frg/`. Local HMAC `latest.json` is the ship-host lookup. The merged tree on Actions does not contain it.
- `auto-tag-release.yml` runs `--validate-tag` against the Actions checkout **before** tag create when `vX.Y.Z` does not already exist. Missing tree `latest.json` exits non-zero (run 32197953276 on 1.39.4). Later notes and tag-create steps run whenever the FRG step exits 0. Docs refresh runs on version-match and fail-closes if the tag is not visible.
- Tugboat phase `wait-release` only polls `gh release view`. After `release finish` it never calls `pipeline release ensure-tag`. Living `tugboat-thin-ship` says Tugboat SHALL NOT invoke `git tag` or `gh release create`.
- `pipeline release finish` merges only (`release-finish.ts`: "this command does not tag") and already returns `mergeCommitOid` in JSON (`gh pr view --json mergeCommit`).
- In-engine `pipeline ship` already calls `ensureAnnotatedReleaseTag` / candidate `release ensure-tag` in publication wait (`ship-adapter.ts`). Buzz Tugboat does not call `pipeline ship`.
- Living CLI is `pipeline release ensure-tag <X.Y.Z> <merge-commit-oid>` (`pipeline.ts`, `runEnsureAnnotatedReleaseTagCli`). It re-observes the merged PR (`assertEnsureTagOidIsMergedRelease`) and validates on-disk HMAC via `validateFrgEvidenceFileForTag`. It does **not** compare HMAC `candidate_git_sha` to an independent this-ship packed SHA.
- Tugboat already records the independent packed SHA as factory-release request `integrated_candidate.git_sha` (`write_factory_release_request`, `read_candidate_sha_from_request`, `SHIP_END_CANDIDATE_SHA`).
- 1.39.5 had on-disk HMAC `latest.json`, no `v1.39.5` tag, no GitHub Release.

**Conflict (do not average):**

1. Living auto-tag law fail-closes when tree-file `latest.json` is missing (`release-auto-tag-on-merge`, `factory-reliability-gate` "attach evidence so auto-tag can still require a pass").
2. Living FRG ignore law forbids committing `.agent-pipeline/frg/` (#1127). Issue non-goal: do not commit `latest.json` so Actions can see it.
3. Living Tugboat law: Tugboat SHALL NOT invoke `git tag`. Issue: after merged release, Tugboat (or `release finish`) SHALL create and push `vX.Y.Z`.
4. Issue criterion 2 (literal): fail-close if HMAC `candidate_git_sha` is not the peeled merge commit. Living pack-then-release sequence: FRG packs the train-integrated candidate, then `pipeline release` usually adds version-bump commits, so the merge commit SHA is usually **not** `candidate_git_sha`. Done-when 4 still requires `wait-release` to succeed.

This change **supersedes** (1) for the gitignored-absent path: local on-disk tag is the source of truth; auto-tag SHALL NOT fail the ship for missing tree-file FRG. It **does not** reverse (2). It **does not** give Tugboat a `git tag` shell; it requires candidate `release ensure-tag` (3). It **does not** require `candidate_git_sha === merge commit` (4); see Decision 3.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat `wait-release` plus auto-tag-release on 1.39.4 / 1.39.5. The class is: after a merged release, the ship-end composer that can see on-disk HMAC `latest.json` must create the annotated tag; Actions must not fail-close on gitignored FRG.
2. **Shared surfaces.** Candidate `pipeline release ensure-tag` / `ensureAnnotatedReleaseTag`; shared `--validate-tag` for **local** disk evidence; auto-tag gitignore/no-op gate. Law lives in `ship-on-disk-frg-tag`, adopted by `tugboat-thin-ship`, `ship-end-candidate-engine`, `ship-coordinator`, `release-auto-tag-on-merge`, `factory-reliability-gate`, `release-sub-command`, and `supervisor-ship-playbook`.
3. **Next identical fault.** The next HMAC-packed, gitignored-FRG ship invokes `release ensure-tag` after merge, pushes `vX.Y.Z`, `release.yml` publishes, `wait-release` succeeds. Auto-tag does not fail the job for missing tree `latest.json`. Tests fail if Tugboat reports pack-done + merged and never invokes tag-create, or if auto-tag still fail-closes solely because gitignored tree-file FRG is absent. No new mole issue.

## Goals / Non-Goals

**Goals:**

- Every ship-end composer invokes candidate `release ensure-tag` after merge, before publication wait.
- Tag create reads on-disk HMAC `latest.json` and fail-closes on missing / not-pass / invalid HMAC / wrong merge OID / unbound packed candidate.
- Packed-candidate proof uses an independent request/checkpoint SHA, not the HMAC artifact as its own authority.
- Existing-tag and concurrent-push paths are idempotent: succeed only for the correct annotated tag on the merge commit; never force-update or delete.
- Auto-tag does not fail the ship when the exact `latest.json` path is absent and gitignored. That branch does not create a tag.
- Tugboat remains a thin composer: no `git tag`, no `gh release create`, no second tag helper.

**Non-Goals:**

- Committing or force-adding `latest.json`.
- `--skip-frg` as the default ship path.
- Moving tag create into `pipeline release finish` (finish stays merge-only).
- Tugboat shelling `git tag`.
- Rebinding HMAC `candidate_git_sha` to a SHA the pack did not attest.
- Comparing packed candidate SHA to the merge commit.
- Changing FRG pack-done, attestor isolation, or train-on-pin / promote-on-pin.
- Publishing GitHub Releases from Tugboat (`release.yml` stays the publisher).

## Decisions

### 1. Tag mutation stays in candidate `release ensure-tag`, not Tugboat and not finish

Tugboat SHALL invoke the recorded candidate CLI after a successful `release finish` and before `wait-release`:

```text
"${SHIP_END_CLI[@]}" release ensure-tag "$version" "$merge_oid" --packed-candidate "$packed_sha"
```

In-engine `pipeline ship` already calls the same helper in publication wait and SHALL pass the same packed-candidate identity. `pipeline release finish` remains merge-only and already emits `mergeCommitOid`.

**Why not `git tag` in Tugboat:** living thin-composer law forbids a second tag implementation. The candidate helper already validates FRG, requires the OID to be the merged release PR, creates an annotated tag, and pushes it.

**Why not tag inside `release finish`:** finish is the merge-authorized command. Mixing merge + tag would change a living "finish does not tag" contract, duplicate the in-engine publication-wait path, and hide the missing Tugboat invoke. The class gap is "composer after merge never calls the helper," not "finish forgot to tag."

**Alternative considered:** only fix auto-tag to skip FRG and let Actions tag. Rejected: Actions still cannot see HMAC; tagging without HMAC would violate fail-closed FRG. Local disk is the only place that can verify HMAC.

### 2. Merge OID source is finish JSON `mergeCommitOid`

Tugboat SHALL parse `mergeCommitOid` from `$RUN_DIR/release-finish.json` (already produced by `pipeline release finish --json`). If the field is missing, not a string, or not exact 40-hex, fail closed before `ensure-tag` and before `wait-release`. Do not use cwd `HEAD`, package version, or train SHA as the tag target.

The candidate helper SHALL peel with `git rev-parse --verify "${oid}^{commit}"` and SHALL re-observe the version's merged release PR (`assertEnsureTagOidIsMergedRelease`). Tugboat SHALL NOT peel in the shell and SHALL NOT shell `git tag`.

**Why:** `release-finish.ts` already observes `gh pr view --json mergeCommit` after merge. Do not guess a second `gh` field in the shell.

### 3. Two SHA identities: tag target vs HMAC packed candidate

| Identity | Independent source (this ship) | HMAC field compared to that source | Role |
| --- | --- | --- | --- |
| Tag target | Finish JSON `mergeCommitOid`, proven equal to the version's merged release PR merge commit | (none) | `git tag -a vX.Y.Z <peeled oid>` |
| Packed candidate | Tugboat: factory-release request `integrated_candidate.git_sha` (already copied to `SHIP_END_CANDIDATE_SHA`). In-engine: `ShipTrainEvidence.integrated_head_oid` / `release.candidate_head_oid` | On-disk `latest.json` `factory_release_binding.candidate_git_sha` if present, else `pack_provenance.candidate_git_sha` | Prove HMAC bound this ship's packed candidate |

The HMAC artifact SHALL NOT be the authority for "this ship's packed candidate." `ensure-tag <version> <mergeOid>` today cannot prove that binding. This change **adds** a required `--packed-candidate <40-hex>` flag to the living two-arg CLI. Missing, empty, or non-40-hex `--packed-candidate` SHALL fail closed before tag create.

Exact comparison: HMAC recorded candidate SHA (lowercase 40-hex) MUST equal `--packed-candidate`. Do **not** compare packed candidate SHA to the merge commit. Do **not** rewrite `latest.json`. Do **not** tag the packed candidate when it differs from the merge commit (the published tree is the merge).

Fail closed when:

- on-disk `latest.json` is missing, unparsable, `pass` is not true, or HMAC is invalid
- supplied OID is not the peeled merge commit of that version's merged release PR
- `--packed-candidate` is missing or is not 40-hex
- HMAC `factory_release_binding.candidate_git_sha` / `pack_provenance.candidate_git_sha` is missing or is not `--packed-candidate`

**Why this side of conflict (4):** requiring `candidate_git_sha === merge commit` would fail every normal pack-then-release-PR ship and contradict `wait-release` success. Rebinding HMAC would be a false attestation. The issue non-goal "do not tag a SHA that does not match the HMAC candidate" is implemented as: HMAC must bind **this ship's packed candidate**, and the tag target must be **this version's merged release PR**, not an unrelated OID.

If a later sequence packs after merge so the two SHAs are equal, both checks still pass.

### 4. Existing tag and concurrent push: succeed only on the correct annotated tag

Before `ensureAnnotatedReleaseTag` / `release ensure-tag` declares success:

- An existing `vX.Y.Z` SHALL be an annotated tag (`git cat-file -t` is `tag`) whose peeled commit equals the peeled merge commit.
- A lightweight existing tag SHALL fail closed. A tag whose peeled commit is not the merge commit SHALL fail closed.
- The helper SHALL NEVER `git push --force`, `git tag -f`, or delete `vX.Y.Z`.

If `git push origin refs/tags/vX.Y.Z` fails because a concurrent writer already created the ref (or after create, the remote disagrees):

1. Re-fetch / re-observe `refs/tags/vX.Y.Z` from origin.
2. Succeed only if that remote tag is annotated and peels to the merge commit.
3. Otherwise fail closed. Do not retarget.

Retries of the same helper on the correct annotated tag SHALL be a successful no-op (`exists`). Wrong existing tags stay fail-closed so a retry cannot promote them.

Auto-tag's existing remote-tag check stays a successful no-op (no force, no delete). Local `ensure-tag` remains the fail-closed owner when the existing tag is the wrong object.

### 5. Auto-tag: gitignored FRG is not a ship-blocking fail

Keep the existing order: detect release merge → version match → tag-already-exists no-op → FRG verify → notes → tag push.

Change only the FRG verify step, and **gate** notes + tag-create + docs-refresh on its output.

Narrow skip (both conditions required):

```text
path=".agent-pipeline/frg/${version}/latest.json"
[ ! -e "$path" ] && git check-ignore --quiet -- "$path"
```

- Exact `latest.json` path is **absent** AND `git check-ignore --quiet -- "$path"` is true: exit 0 from the FRG step, set an output that **prevents** notes and tag-create (`taggable=false` or equivalent). Do not invoke `--validate-tag`. Do not create a tag. Local `ensure-tag` owns create/push.
- File exists (ignored or not): keep `--validate-tag` against the checked-out file. Existing-but-invalid, malformed, `pass: false`, or invalid HMAC SHALL fail closed. The ignored branch SHALL NOT create a tag.
- File missing and **not** ignored: keep today's fail-closed `--validate-tag` (missing tree file).
- Tag already exists: unchanged successful no-op **before** FRG verify.

**Docs refresh:** today's step runs on version-match and fail-closes if `refs/tags/vX.Y.Z` is not visible. After a gitignored-absent skip, that would still fail the job. When the skip output is set and the tag is not visible after fetch, docs refresh SHALL be a successful no-op. It SHALL NOT fail the job. If the tag is visible (local ensure-tag won the race), the existing refresh path MAY run. `wait-release` does not depend on CHANGELOG.

**Why not skip FRG and let Actions tag anyway:** Actions has no HMAC. Local helper does.

**Why not leave auto-tag fail-closed:** a red auto-tag job is noise, and a race where auto-tag runs before local push currently fails closed with no tag. Local `ensure-tag` still creates the tag, but the class defect (Actions punishing gitignore) remains.

### 6. `wait-release` stays `gh release view`

Do not change the publication predicate. After `ensure-tag` pushes `vX.Y.Z`, `release.yml` publishes. `wait-release` succeeds when the Release is non-draft. No human `git tag`. Ensure-tag non-zero SHALL stop the ship before `wait-release`.

### 7. Composer inventory (every actual launcher)

| Surface | Role | This change |
| --- | --- | --- |
| `examples/supervisor/shell/tugboat.sh` | Thin ship composer | Parse finish JSON; fail closed on bad `mergeCommitOid`; invoke candidate `release ensure-tag … --packed-candidate`; stop before `wait-release` on any failure |
| `examples/supervisor/shell/pipeline-ship-playbook.sh` | Thin launcher | Stays `exec` of repo `tugboat.sh`. No second compose. Comment/docs name ensure-tag as inherited Tugboat phase |
| In-engine `pipeline ship` (`bindCandidateShipEndOperations.waitForPublication` and pin `waitForPublication`) | Product ship | Keep invoking `ensure-tag` / `ensureAnnotatedReleaseTag` from on-disk HMAC. Pass `--packed-candidate` from `release.candidate_head_oid` / train `integrated_head_oid` |
| `pipeline release finish` (`release-finish.ts`) | Merge-only | No tag create. Keep emitting `mergeCommitOid`. Tests still assert finish does not tag |
| `examples/supervisor/hermes/SKILL.md` | Docs, not a composer | Name Tugboat ensure-tag in the phase list. Do not add a Hermes `git tag` |

Doctor / install-parity continues to bind installed Tugboat to candidate `tugboat.sh`. A stale installed script without ensure-tag fails the composer check.

### 8. Dependency audit at this base (do not assume #1115/#1151 APIs)

**Already present (reuse, do not reimplement):**

- CLI `pipeline release ensure-tag <X.Y.Z> <merge-commit-oid>` and `runEnsureAnnotatedReleaseTagCli`
- `ensureAnnotatedReleaseTag`, `verifyAnnotatedReleaseTag`, `assertEnsureTagOidIsMergedRelease`
- On-disk `validateFrgEvidenceFileForTag` / `--validate-tag`
- Finish JSON `mergeCommitOid`
- Tugboat `SHIP_END_CLI`, `SHIP_END_CANDIDATE_SHA`, `read_candidate_sha_from_request`
- Playbook thin `exec` of repo Tugboat
- In-engine publication wait already spawns candidate `release ensure-tag`
- `.agent-pipeline/frg/` gitignored (#1127)

**Not present (include as work in this change, not a hidden dependency):**

- Independent packed-candidate comparison (HMAC is currently self-referential)
- Required `--packed-candidate <40-hex>` on `release ensure-tag`
- Tugboat post-finish ensure-tag invoke and finish-JSON parse
- Auto-tag exact-path gitignored-absent skip that **also gates** notes, tag-create, and docs-refresh
- Concurrent-push re-observe of the remote tag
- Behavioral Tugboat harness for post-finish phase order

Do not implement against a third positional OID, a skip-frg auto-tag path, or a validator that treats directory-level ignore as sufficient.

### 9. Tests prove the missing invoke, not a live tag

Required bite (each MUST fail on current code):

- Tugboat **behavioral** harness (PATH-stub / spied `SHIP_END_CLI`, same pattern as `writeFakePipeline` in `tugboat.test.ts`): pack-done + merged release + eligible on-disk HMAC + no tree `latest.json` + composer never invokes `release ensure-tag` → fail. Assert argv order: `release finish` then `release ensure-tag <ver> <40-hex> --packed-candidate <40-hex>` then no `gh release view` if ensure-tag fails.
- Source/thinness check still forbids `git tag` / `gh release create` as the tag path and forbids finish→wait-release with no ensure-tag.
- Auto-tag extracted FRG-step script: exact path absent + `git check-ignore` true → exit 0 and does not `git tag`. Same script with absent + not ignored → non-zero. Existing-but-invalid file (even if ignored) → non-zero. Notes/tag-create `if:` must not run when skip output is set.
- Ensure-tag unit (injected git / observe / validateFrg): missing disk HMAC; `pass: false`; invalid HMAC; wrong supplied OID; unbound HMAC candidate vs `--packed-candidate`; packed SHA ≠ merge SHA still tags merge; correct annotated existing tag → `exists`; lightweight or wrong-target existing tag → fail, no force; concurrent push failure then remote correct tag → `exists`; concurrent remote wrong tag → fail.

Inject I/O. No live `git tag` push, network, or GitHub in unit tests. Shell tests may use the existing Tugboat PATH-stub pattern.

## Risks / Trade-offs

- **[Race] auto-tag and local ensure-tag both try to create `vX.Y.Z`.** → Auto-tag remote-exists no-op; local helper re-observes and succeeds only on the correct annotated tag. Neither force-retags.
- **[Docs] auto-tag skip before the local tag exists.** → Docs refresh MUST no-op when the tag is not visible. `wait-release` does not depend on CHANGELOG. Finish already MAY heal docs after observing the tag.
- **[Packed SHA ≠ merge SHA] reviewers may re-flag issue criterion 2.** → Named in this design. Literal equality would stall every normal release PR. Specs state both identities and the fail-closed set. Do not rebind HMAC.
- **[Installed Tugboat stale] factory host runs old `tugboat.sh` without ensure-tag.** → Same class as #1151 playbook/candidate-engine parity. This change's composer test fails if the candidate script omits `release ensure-tag`. Refresh remains the existing install loop.
- **[FRG step exit 0 still tags]** → Gate notes and tag-create on an explicit skip/taggable output. Do not rely on FRG step exit 0 alone.

## Migration Plan

- Land the OpenSpec change, then implement in the same issue worktree.
- After `core/` edits, regenerate `plugin/` in the same commit.
- Refresh installed Tugboat from candidate `examples/supervisor/shell/tugboat.sh` on the factory host as part of the existing ship-end install loop (not a new installer).
- Rollback: revert the change. Auto-tag fail-closed on missing tree FRG returns. Tugboat wait-release stalls again without a human tag. That is the defect.

## Open Questions

None. SHA-identity conflict is resolved in Decision 3. Tag owner is Decision 1. Auto-tag gitignore behavior is Decision 5. Packed-candidate authority is Decision 3. Race behavior is Decision 4. Dependency audit is Decision 8.
