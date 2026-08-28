## Context

See `proposal.md` for motivation. Current law and code:

- Park-release (`releaseWorktreeForParkedIssue`, #718) releases a managed worktree on durable park when the tree is clean, local-only verification is clean, and a remote tip **or** open PR head exists. After squash merge the remote head is deleted and the PR is no longer open, so that recoverability path fails.
- Ready-to-deploy removal (`removeManagedWorktreeSafely` in `deploy_ready`) uses `evaluateRemoveSafety` once. `localOnly === "unverifiable"` (remote gone, commits not in base) is the squash-merge tier with `--force` wording. `localOnly === null` is hard-blocked as `commit verification failed (git/network/auth error); check connectivity and retry`.
- `checkLocalOnlyCommits` returns `null` when `ls-remote` fails **or** when the remote head is already absent and `git log origin/<base>..HEAD` fails. After GitHub deletes the squash-merged branch, that second path is post-squash-merge unreachability, not a transport failure. `deploy_ready` then logs `worktree retained after ready-to-deploy (commit verification failed (git/network/auth error); check connectivity and retry)`.
- `train --merge` already proves `merge_result_oid` is contained in `origin/<base>` (`[train] #N: proving merge … is in origin/<base>` then `integrated`). That proof is not an input to park-release today.
- #718 is capacity retention for **blocked** items. This change is retention after a **successful, engine-verified merge** with a false diagnosis.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The sites are #290 (`/pipeline`) and #269 (`train --merge`, PR #302). The class is: the shared park-release / automatic-remove verification gate treats post-squash-merge unreachability as git/network/auth and ignores bound merge-result proof the engine already produced.
2. **Shared surfaces.** Classifier (`checkLocalOnlyCommits` tiers), shared ladder (`evaluateRemoveSafety` / `removeManagedWorktreeSafely`), park-release (`releaseWorktreeForParkedIssue` and `deploy_ready` automatic remove). Callers: `/pipeline`, `pipeline single`, `train --merge`. Not a #269-only or #290-only skip.
3. **Next identical fault.** The next squash merge with `merge_result_oid` proven in `origin/<base>` and a clean managed worktree takes this gate and releases. It does not need a new mole issue.

## Goals / Non-Goals

**Goals:**

- Feed bound merge-result proof (issue, PR, base, proven OID) into the shared automatic-release gate.
- Release a clean managed worktree when that proof is present, including after squash merge deleted the remote head.
- Classify remote-deleted + not-reachable-from-base as squash-merge unreachability, never as git/network/auth, when the missing remote head was observed.
- Keep dirty trees and cleanup failures; report those causes; do not roll back ready-to-deploy or integrated state.

**Non-Goals:**

- Changing squash vs merge-commit policy or merge authority.
- Merge inside advance/loop, auto-merge, or a merge stage.
- Making `/pipeline:cleanup` the required fix.
- Passing `--force` to discard dirty work as a shortcut around unverifiable state.
- Cross-host worktree locking.
- Operator `--remove-worktree` auto-success without bound proof (existing unverifiable / `--force` table stays for that surface).

## Decisions

### 1. Bound proof is a runtime-validated `VerifiedMergeProof` carrier

**Choice:** One in-process type `VerifiedMergeProof` with fields `{ issue, pr, base, mergeResultOid }`. The only constructor is `createVerifiedMergeProof`. It runtime-validates: issue and PR are positive integers; `base` is a non-empty string; `mergeResultOid` is a 40-char hex SHA. The only production caller of that constructor is `proveMergeResultInBase` (the in-base verifier) after `isAncestor(oid, fetchedBaseTip)` returns true. Callers pass that object directly into the shared release gate. Park-release SHALL NOT reconstruct proof from run logs, GitHub labels, issue comments, or untyped persisted JSON.

Identity match is exact: the proof's issue, PR, base, and OID must equal this worktree's issue, this PR, `cfg.base_branch`, and the OID the verifier just proved. A mismatch on any one field does not release this tree.

**Why:** Temporal proximity ("we just merged something") cannot bind reliability evidence. Logs and labels are not a verifier. The engine already proves containment in `mergeReadyToDeployItem` / `reconcileMergedPrIntegration`; that success is the mint site.

**Alternatives considered:**

- "Any merged PR for this issue" → rejected. A historical merged PR must not release a live worktree for a different head.
- "Base contains any commit from this branch" → rejected. Squash merge replaces those SHAs; that is the bug's reachability check.
- Reconstruct from `train_merge_proven` events or `pipeline:ready-to-deploy` + merged PR state → rejected. Untyped persisted data is not a verifier result.

### 2. Extend the shared ladder; do not pass `--force`

**Choice:** Automatic release (park-release and `deploy_ready` via `removeManagedWorktreeSafely`) takes bound proof as an input to the **same** safety evaluation. When proof matches and the tree is clean, squash-merge unreachability is not a retain. Dirty remains a retain. Implementation MUST NOT set `force: true` to skip unverifiable, because `force` also authorizes dirty discard.

**Why:** Class-over-site. A train-only `git worktree remove` or a deploy_ready-only skip would leave the other caller broken. Reusing `--force` would violate dirty-tree AC.

**Alternatives considered:**

- Train-only remove after `integrated` → mole; `/pipeline` would still lie about git/network/auth.
- `force: true` when proof is present → would delete dirty trees.
- Only fix the `null` vs `"unverifiable"` string → correct diagnosis, but still retain after proven merge (open PR gone, remote tip gone).

### 3. Classifier taxonomy: remote-head observation vs reachability vs transport

**Choice:** `checkLocalOnlyCommits` uses this exact table. Do not collapse `ls-remote` transport failure with expected non-ancestry.

| Remote-head observation | Reachability probe | Result |
| --- | --- | --- |
| `ls-remote` non-zero (git/network/auth/spawn) | not run | `null` (verification-failed). Bound proof absent → retain with git/network/auth. |
| `ls-remote` code 0, non-empty SHA | existing remote-present logic | `true` / `false` / `null` as today |
| `ls-remote` code 0, empty SHA (remote head absent) | `git log origin/<base>..HEAD` (and branch range) code 0, empty stdout | `false` (all reachable) |
| `ls-remote` code 0, empty SHA | log code 0 with commits **or** `git merge-base --is-ancestor` / equivalent **exit 1** (documented non-ancestry) | `"unverifiable"` (squash-merge unreachability) |
| `ls-remote` code 0, empty SHA | reachability command error (exit ≥ 128, spawn, timeout). Exit 1 after observed-absent is **not** this row. | `"unverifiable"`, not `null`. Keep the existing squash-merge / `--force` wording. Do not map to git/network/auth. Preserve the underlying command diagnostic in test seams / logs when the probe could not prove ancestry. |

The shared ladder (`evaluateRemoveSafety`) maps `"unverifiable"` to the existing not-reachable message and `null` to git/network/auth. Bound matching proof authorizes release of a **clean** tree when localOnly is `"unverifiable"` (and also when it is `null`, so a leftover misclassification cannot revive the #290/#269 wording). Bound proof never bypasses managed-root validation, dirty detection, or `localOnly === true`. Implementation MUST NOT set `force: true` to skip unverifiable.

**Why:** After squash, GitHub deletes the head ref. `ls-remote` succeeds with an empty SHA. `git log origin/<base>..HEAD` then often fails (missing `origin/<base>` in the worktree, exit 128) or reports non-ancestry. Today that becomes `null` and `commit verification failed (git/network/auth error)`. Exit 1 is the documented non-ancestry status for `merge-base --is-ancestor`; it must not be treated as transport failure.

**Alternatives considered:**

- Treat every `git log` failure as transport failure → status quo; false git/network/auth after squash.
- Treat `ls-remote` exit 1 the same as empty remote head → rejected. A failed remote-head observation stays transport/auth.

### 4. Cleanup is best-effort after merge/integration is recorded

**Choice:** Record merge proof / `train_merge_proven` / `train_merge_integrated` / `pipeline:ready-to-deploy` first. Then attempt worktree cleanup. If remove fails or the tree is dirty, keep **only that** worktree, report the filesystem/cleanup or dirty reason, and **do not** invoke label or integration rollback (`setBlocked`, label removal, clearing `integrated`). Ready-to-deploy and integrated state stay as already recorded.

**Why:** Merge already happened. Cleanup is not a merge gate. Rolling back labels would lie about integration.

### 5. Authoritative callers pass the same proof into the same shared APIs

**Choice:** Three callers, two shared functions, one ladder. No train-only remover.

1. `maybeReleaseWorktreeOnPark` (`/pipeline` / `pipeline single`) → `releaseWorktreeForParkedIssue(cfg, issue, { verifiedMergeProof })`.
2. `deploy_ready.finalize` automatic removal → `removeManagedWorktreeSafely(..., { verifiedMergeProof, force: false })`.
3. `train --merge` after `mergeReadyToDeployItem` / `reconcileMergedPrIntegration` returns `kind: "integrated"` with an OID → mint `VerifiedMergeProof` via `proveMergeResultInBase` (or `createVerifiedMergeProof` immediately after the existing successful `isAncestor` in that same call) → `releaseWorktreeForParkedIssue` with that object.

`/pipeline` deploy_ready mints the same way when the linked PR is already merged: observe merge OID, fetch base, `isAncestor`, then `createVerifiedMergeProof`. If the PR is still open, there is no proof (pre-merge R2D path unchanged).

Train SHALL NOT add a `git worktree remove` path, a second recoverer in `train.ts`, or a wrapper that re-implements dirty/proof checks. `core/test/worktree-remove-safety-registry.test.ts` must still classify train as ladder-backed if it gains a remove call (it must call `releaseWorktreeForParkedIssue`).

**Why:** Ship-path constitution: class over site; no second recoverer inside `train.ts`. A train-only delete would leave `/pipeline` emitting git/network/auth.

## Risks / Trade-offs

- **[Risk] Stale proof from a previous PR on the same issue releases a newer dirty or unpushed tree.** → Mitigation: bind PR number and OID; dirty and definitive local-only still retain.
- **[Risk] Real network failure is reclassified as unverifiable and then released with weak proof.** → Mitigation: unverifiable-from-remote-absent still retains without bound proof; release requires the engine-proven OID in `origin/<base>`.
- **[Risk] Passing bound proof only from train leaves `/pipeline` broken.** → Mitigation: `deploy_ready.finalize` mints `VerifiedMergeProof` via the same in-base verifier when the linked PR is already merged; caller-seam tests assert both train and park/deploy_ready pass that object into the shared APIs.
- **[Risk] Bound proof bypasses dirty or local-only safety.** → Mitigation: `evaluateRemoveSafety` still blocks `dirty` and `localOnly === true` when `boundProofMatches` is true; tests cover managed-root, dirty, and definitive local-only independently.
- **[Risk] Operator `--remove-worktree` behavior drifts.** → Mitigation: that surface keeps the existing unverifiable / `--force` table unless the same bound proof is supplied; this change does not auto-force operator remove.

## Migration Plan

- Ship as a normal pipeline change: core + regenerated `plugin/` in the same commit.
- No config key, no label migration, no data backfill.
- Already-stranded worktrees from prior false git/network/auth retains stay on disk until this gate runs again (re-run `/pipeline` / train with bound proof, or existing `--force` / `--cleanup`). This change does not sweep them in the background.

## Open Questions

None. A clean managed worktree is released when bound merge proof is present. Cleanup is best-effort. A filesystem failure keeps the worktree and reports that failure. Ready-to-deploy and integrated state do not change when cleanup fails.
