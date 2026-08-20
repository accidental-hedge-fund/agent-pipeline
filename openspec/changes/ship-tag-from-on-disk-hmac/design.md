## Context

See `proposal.md` for why. Current law and code:

- `#1127` gitignores `.agent-pipeline/frg/`. Local HMAC `latest.json` is the ship-host lookup. The merged tree on Actions does not contain it.
- `auto-tag-release.yml` runs `--validate-tag` against the Actions checkout **before** tag create when `vX.Y.Z` does not already exist. Missing tree `latest.json` exits non-zero (run 32197953276 on 1.39.4).
- Tugboat phase `wait-release` only polls `gh release view`. After `release finish` it never calls `pipeline release ensure-tag`. Living `tugboat-thin-ship` says Tugboat SHALL NOT invoke `git tag` or `gh release create`.
- `pipeline release finish` merges only (`release-finish.ts`: "this command does not tag") and already returns `mergeCommitOid` in JSON (`gh pr view --json mergeCommit`).
- In-engine `pipeline ship` already calls `ensureAnnotatedReleaseTag` in publication wait (`ship-adapter.ts`). Buzz Tugboat does not call `pipeline ship`.
- 1.39.5 had on-disk HMAC `latest.json`, no `v1.39.5` tag, no GitHub Release.

**Conflict (do not average):**

1. Living auto-tag law fail-closes when tree-file `latest.json` is missing (`release-auto-tag-on-merge`, `factory-reliability-gate` "attach evidence so auto-tag can still require a pass").
2. Living FRG ignore law forbids committing `.agent-pipeline/frg/` (#1127). Issue non-goal: do not commit `latest.json` so Actions can see it.
3. Living Tugboat law: Tugboat SHALL NOT invoke `git tag`. Issue: after merged release, Tugboat (or `release finish`) SHALL create and push `vX.Y.Z`.
4. Issue criterion 2 (literal): fail-close if HMAC `candidate_git_sha` is not the peeled merge commit. Living pack-then-release sequence: FRG packs the train-integrated candidate, then `pipeline release` usually adds version-bump commits, so the merge commit SHA is usually **not** `candidate_git_sha`. Done-when 4 still requires `wait-release` to succeed.

This change **supersedes** (1) for the gitignored path: local on-disk tag is the source of truth; auto-tag SHALL NOT fail the ship for missing tree-file FRG. It **does not** reverse (2). It **does not** give Tugboat a `git tag` shell; it requires candidate `release ensure-tag` (3). It **does not** require `candidate_git_sha === merge commit` (4); see Decision 3.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is Tugboat `wait-release` plus auto-tag-release on 1.39.4 / 1.39.5. The class is: after a merged release, the ship-end composer that can see on-disk HMAC `latest.json` must create the annotated tag; Actions must not fail-close on gitignored FRG.
2. **Shared surfaces.** Candidate `pipeline release ensure-tag` / `ensureAnnotatedReleaseTag` (already the in-engine tag helper); shared `--validate-tag` for **local** disk evidence; auto-tag gitignore/no-op gate. Law lives in `ship-on-disk-frg-tag`, adopted by `tugboat-thin-ship`, `ship-end-candidate-engine`, `ship-coordinator`, `release-auto-tag-on-merge`, `factory-reliability-gate`, `release-sub-command`, and `supervisor-ship-playbook`.
3. **Next identical fault.** The next HMAC-packed, gitignored-FRG ship invokes `release ensure-tag` after merge, pushes `vX.Y.Z`, `release.yml` publishes, `wait-release` succeeds. Auto-tag does not fail the job for missing tree `latest.json`. Tests fail if Tugboat reports pack-done + merged and never invokes tag-create, or if auto-tag still fail-closes solely because gitignored tree-file FRG is absent. No new mole issue.

## Goals / Non-Goals

**Goals:**

- Every ship-end composer invokes candidate `release ensure-tag` after merge, before publication wait.
- Tag create reads on-disk HMAC `latest.json` and fail-closes on missing / not-pass / invalid HMAC / wrong merge OID / unbound packed candidate.
- Auto-tag does not fail the ship when FRG is gitignored.
- Tugboat remains a thin composer: no `git tag`, no `gh release create`, no second tag helper.

**Non-Goals:**

- Committing or force-adding `latest.json`.
- `--skip-frg` as the default ship path.
- Moving tag create into `pipeline release finish` (finish stays merge-only).
- Tugboat shelling `git tag`.
- Rebinding HMAC `candidate_git_sha` to a SHA the pack did not attest.
- Changing FRG pack-done, attestor isolation, or train-on-pin / promote-on-pin.
- Publishing GitHub Releases from Tugboat (`release.yml` stays the publisher).

## Decisions

### 1. Tag mutation stays in candidate `release ensure-tag`, not Tugboat and not finish

Tugboat SHALL invoke `"${SHIP_END_CLI[@]}" release ensure-tag "$version" "$merge_oid"` after a successful `release finish` and before `wait-release`. In-engine `pipeline ship` already calls the same helper in publication wait. `pipeline release finish` remains merge-only and already emits `mergeCommitOid`.

**Why not `git tag` in Tugboat:** living thin-composer law forbids a second tag implementation. The candidate helper already validates FRG, requires the OID to be the merged release PR, creates an annotated tag, and pushes it.

**Why not tag inside `release finish`:** finish is the merge-authorized command. Mixing merge + tag would change a living "finish does not tag" contract, duplicate the in-engine publication-wait path, and hide the missing Tugboat invoke. The class gap is "composer after merge never calls the helper," not "finish forgot to tag."

**Alternative considered:** only fix auto-tag to skip FRG and let Actions tag. Rejected: Actions still cannot see HMAC; tagging without HMAC would violate fail-closed FRG. Local disk is the only place that can verify HMAC.

### 2. Merge OID source is finish JSON `mergeCommitOid`

Tugboat SHALL parse `mergeCommitOid` from `$RUN_DIR/release-finish.json` (already produced by `pipeline release finish --json`). Peel with `git rev-parse --verify "${oid}^{commit}"` in the candidate helper (already required by `ensure-tag`). If `mergeCommitOid` is missing or not 40-hex, fail closed before `ensure-tag`. Do not use cwd `HEAD`, package version, or train SHA as the tag target.

**Why:** `release-finish.ts` already observes `gh pr view --json mergeCommit` after merge. Do not guess a second `gh` field in the shell.

### 3. Two SHA identities: tag target vs HMAC packed candidate

| Identity | Source | Role |
| --- | --- | --- |
| Tag target | Peeled merge commit of the version's merged release PR | `git tag -a vX.Y.Z <oid>` |
| HMAC `candidate_git_sha` | On-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` | Packed candidate this ship attested |

Fail closed when:

- on-disk `latest.json` is missing, unparsable, `pass` is not true, or HMAC is invalid
- supplied OID is not the peeled merge commit of that version's merged release PR
- HMAC `candidate_git_sha` is missing or is not this ship's FRG-bound packed candidate (`integrated_candidate.git_sha` / ship train head)

Do **not** fail solely because packed candidate SHA ≠ merge commit SHA. Do **not** rewrite `latest.json` so those SHAs match. Do **not** tag the packed candidate when it differs from the merge commit (the published tree is the merge).

**Why this side of conflict (4):** requiring `candidate_git_sha === merge commit` would fail every normal pack-then-release-PR ship and contradict `wait-release` success. Rebinding HMAC would be a false attestation. The issue non-goal "do not tag a SHA that does not match the HMAC candidate" is implemented as: HMAC must bind **this ship's packed candidate**, and the tag target must be **this version's merged release PR**, not an unrelated OID.

If a later sequence packs after merge so the two SHAs are equal, both checks still pass.

### 4. Auto-tag: gitignored FRG is not a ship-blocking fail

Keep the existing order: detect release merge → version match → tag-already-exists no-op → FRG verify → notes → tag push.

Change only the FRG verify step:

- If `git check-ignore -q .agent-pipeline/frg/` (or the version `latest.json` path) is true **and** tree-file `latest.json` is absent: **successful no-op for tagging**. Do not exit non-zero. Do not create a tag. Local `ensure-tag` owns create/push. If the tag later appears, the existing exists-check already no-ops on a rerun.
- If FRG is **not** gitignored: keep today's fail-closed `--validate-tag` against the tree (committed evidence still required).
- If the tag already exists: unchanged successful no-op (this already runs **before** FRG verify).

**Why not skip FRG and let Actions tag anyway:** Actions has no HMAC. Local helper does.

**Why not leave auto-tag fail-closed:** a red auto-tag job is noise, and a race where auto-tag runs before local push currently fails closed with no tag. Local `ensure-tag` still creates the tag, but the class defect (Actions punishing gitignore) remains. Next identical fault would still look like a broken auto-tag.

**Docs refresh:** when auto-tag no-ops because gitignored FRG is absent and the tag does not exist yet, docs refresh SHALL still run if the tag becomes visible after fetch (existing "tag already existed" path). If the tag is not visible, docs refresh fail-closed without deleting anything; local tag + a later auto-tag rerun or finish's optional heal can refresh CHANGELOG. Do not block `wait-release` on CHANGELOG (publication is GitHub Release).

### 5. `wait-release` stays `gh release view`

Do not change the publication predicate. After `ensure-tag` pushes `vX.Y.Z`, `release.yml` publishes. `wait-release` succeeds when the Release is non-draft. No human `git tag`.

### 6. Tests prove the missing invoke, not a live tag

Required bite:

- Tugboat/composer fixture: pack-done + merged release + on-disk eligible `latest.json` + no tree `latest.json` + never invokes `release ensure-tag` → test fails.
- Auto-tag workflow/unit: gitignored missing tree `latest.json` + current fail-closed step → test fails once the workflow still exits non-zero for that case.
- Ensure-tag unit: missing disk HMAC / `pass: false` / wrong merge OID / unbound `candidate_git_sha` → no tag push (existing `validateFrg` / `assertEnsureTagOidIsMergedRelease` seams).

Inject I/O. No live `git tag`, network, or GitHub in unit tests. Shell tests may use the existing Tugboat PATH-stub pattern.

## Risks / Trade-offs

- **[Race] auto-tag and local ensure-tag both try to create `vX.Y.Z`.** → Existing remote-exists no-op on auto-tag; `ensureAnnotatedReleaseTag` no-ops when the annotated tag already points at the merge. Neither force-retags.
- **[Docs] auto-tag no-ops before the local tag exists, so CHANGELOG refresh may lag one job.** → `wait-release` does not depend on CHANGELOG. Finish already MAY heal docs after observing the tag. A later default-branch push with the tag present still refreshes. Accept lag over blocking the ship.
- **[Packed SHA ≠ merge SHA] reviewers may re-flag issue criterion 2.** → Named in this design. Literal equality would stall every normal release PR. Specs state both identities and the fail-closed set. Do not rebind HMAC.
- **[Installed Tugboat stale] factory host runs old `tugboat.sh` without ensure-tag.** → Same class as #1151 playbook/candidate-engine parity. Doctor / install-parity already binds installed Tugboat to candidate `tugboat.sh`. This change's composer test fails if the candidate script omits `release ensure-tag`. Refresh remains the existing install loop.

## Migration Plan

- Land the OpenSpec change, then implement in the same issue worktree.
- After `core/` edits, regenerate `plugin/` in the same commit.
- Refresh installed Tugboat from candidate `examples/supervisor/shell/tugboat.sh` on the factory host as part of the existing ship-end install loop (not a new installer).
- Rollback: revert the change. Auto-tag fail-closed on missing tree FRG returns. Tugboat wait-release stalls again without a human tag. That is the defect.

## Open Questions

None. SHA-identity conflict is resolved in Decision 3. Tag owner is Decision 1. Auto-tag gitignore behavior is Decision 4.
