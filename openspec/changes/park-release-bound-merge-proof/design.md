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

### 1. Bound proof is an explicit identity tuple, not recency

**Choice:** Park-release accepts bound proof only as `{ issue, pr, base, merge_result_oid }` where the engine has already proven that OID is contained in `origin/<base>` for that identity. A proof for another issue, PR, base, or OID does not release this tree.

**Why:** Temporal proximity ("we just merged something") cannot bind reliability evidence. The engine already records `merge_result_oid` on the train merge path; `/pipeline` can carry the same identity from the merge surface or from the just-proven observation.

**Alternatives considered:**

- "Any merged PR for this issue" → rejected. A historical merged PR must not release a live worktree for a different head.
- "Base contains any commit from this branch" → rejected. Squash merge replaces those SHAs; that is the bug's reachability check.

### 2. Extend the shared ladder; do not pass `--force`

**Choice:** Automatic release (park-release and `deploy_ready` via `removeManagedWorktreeSafely`) takes bound proof as an input to the **same** safety evaluation. When proof matches and the tree is clean, squash-merge unreachability is not a retain. Dirty remains a retain. Implementation MUST NOT set `force: true` to skip unverifiable, because `force` also authorizes dirty discard.

**Why:** Class-over-site. A train-only `git worktree remove` or a deploy_ready-only skip would leave the other caller broken. Reusing `--force` would violate dirty-tree AC.

**Alternatives considered:**

- Train-only remove after `integrated` → mole; `/pipeline` would still lie about git/network/auth.
- `force: true` when proof is present → would delete dirty trees.
- Only fix the `null` vs `"unverifiable"` string → correct diagnosis, but still retain after proven merge (open PR gone, remote tip gone).

### 3. Classifier: observed remote-absent is not transport failure

**Choice:** When `ls-remote` (or equivalent) **succeeds** and the remote head ref is empty, the missing-head + not-in-base outcome is squash-merge unreachability (`"unverifiable"`), even if `git log origin/<base>..HEAD` then fails. `null` / git/network/auth remains only when the transport cannot tell whether the remote head exists (and bound proof is absent). Bound proof short-circuits the need to prove pre-squash SHAs are in the base.

**Why:** That is the observed false diagnosis. One path already names the squash-merge case; the `null` path must not steal it after a successful empty `ls-remote`.

**Alternatives considered:**

- Treat every `git log` failure as transport failure → status quo; false git/network/auth after squash.
- Treat every `git log` failure as unverifiable → would hide a real missing `origin/<base>` fetch failure when no merge proof exists. Acceptable only after remote-absent was observed; still retain without bound proof.

### 4. Cleanup is best-effort; labels do not roll back

**Choice:** If remove fails after proven merge, keep that worktree, report the filesystem/cleanup error, leave `pipeline:ready-to-deploy` and integrated state unchanged.

**Why:** Merge already happened. Cleanup is not a merge gate. Rolling back labels would lie about integration.

### 5. Train passes proof into the shared gate; it does not grow a second recoverer

**Choice:** After `train --merge` records `train_merge_proven` / `train_merge_integrated` with `merge_result_oid`, the train (or the pipeline finalize it already composes) calls the shared park-release helper with that bound tuple. No train-local worktree destroyer. No second recoverer in `train.ts`.

**Why:** Ship-path constitution: class over site; no second recoverer inside `train.ts`.

## Risks / Trade-offs

- **[Risk] Stale proof from a previous PR on the same issue releases a newer dirty or unpushed tree.** → Mitigation: bind PR number and OID; dirty and definitive local-only still retain.
- **[Risk] Real network failure is reclassified as unverifiable and then released with weak proof.** → Mitigation: unverifiable-from-remote-absent still retains without bound proof; release requires the engine-proven OID in `origin/<base>`.
- **[Risk] Passing bound proof only from train leaves `/pipeline` broken.** → Mitigation: the gate is shared; tests cover both caller seams.
- **[Risk] Operator `--remove-worktree` behavior drifts.** → Mitigation: that surface keeps the existing unverifiable / `--force` table unless the same bound proof is supplied; this change does not auto-force operator remove.

## Migration Plan

- Ship as a normal pipeline change: core + regenerated `plugin/` in the same commit.
- No config key, no label migration, no data backfill.
- Already-stranded worktrees from prior false git/network/auth retains stay on disk until this gate runs again (re-run `/pipeline` / train with bound proof, or existing `--force` / `--cleanup`). This change does not sweep them in the background.

## Open Questions

None. A clean managed worktree is released when bound merge proof is present. Cleanup is best-effort. A filesystem failure keeps the worktree and reports that failure. Ready-to-deploy and integrated state do not change when cleanup fails.
