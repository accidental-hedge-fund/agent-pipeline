## Why

After a successful squash merge, park-release keeps the managed worktree and reports `commit verification failed (git/network/auth error); check connectivity and retry`. That diagnosis is false. The merge already completed, the engine already proved `merge_result_oid` is in `origin/<base>`, and git/`gh`/network worked in the same run. Observed on #290 (`/pipeline`) and #269 (`train --merge`, PR #302) on agent-pipeline v1.39.13 with `base_branch: develop`. Worktrees pile up under `worktree_root`, and the operator debugs connectivity that did not fail.

This is a class defect in the shared park-release verification/release gate. It is not a site mole for #269 or #290. One path already names post-squash-merge unreachability (remote branch deleted, pre-merge commits not reachable from the base). Another path maps the same condition to git/network/auth. The engine already has bound merge-result proof; the gate does not use it.

## What Changes

- Park-release SHALL treat bound merge-result proof as sufficient recoverability for a **clean** managed worktree. Proof is the same issue number, the same PR number, the same base branch, and a `merge_result_oid` the engine has proven is contained in `origin/<base>`.
- On that proven-merge path, park-release SHALL remove the worktree from `worktree_root` and SHALL NOT emit git/network/auth wording or tell the operator to check connectivity or retry.
- Proof for a different issue, PR, base, or OID SHALL NOT release this worktree.
- If filesystem cleanup fails after that proven merge, park-release SHALL keep only that worktree, SHALL report the actual filesystem/cleanup error, SHALL NOT report git/network/auth, and SHALL NOT change `pipeline:ready-to-deploy` or integrated state.
- If the managed worktree is dirty after that proven merge, park-release SHALL keep the worktree, SHALL report the dirty-worktree cause, SHALL NOT report git/network/auth, and SHALL NOT change `pipeline:ready-to-deploy` or integrated state.
- If the remote branch is deleted and the engine does **not** have bound merge-result proof in `origin/<base>`, park-release SHALL keep the worktree and SHALL report that commits are not reachable from the base (the existing squash-merge/`--force` message). It SHALL NOT map that case to git/network/auth.
- The same release gate SHALL apply after `/pipeline` / `pipeline single` and after `train --merge`. The next identical post-squash-merge case SHALL take this gate without a new mole issue.

**BREAKING:** none. Merge policy, squash vs merge-commit, merge authority, and ready-to-deploy/integrated labels do not change.

## Capabilities

### New Capabilities

- None. This is a class fix to the existing park-release verification/release gate.

### Modified Capabilities

- `parked-item-worktree-release`: Bound merge-result proof (issue + PR + base + proven `merge_result_oid` in `origin/<base>`) SHALL authorize release of a clean managed worktree. Post-squash-merge unreachability without that proof SHALL retain with the squash-merge/not-reachable message, never git/network/auth. Cleanup failure and dirty-worktree retain the tree, report the true cause, and do not change ready-to-deploy or integrated state.
- `worktree-per-run-removal`: The shared remove-safety ladder (`evaluateRemoveSafety` / `removeManagedWorktreeSafely` / deploy_ready removal) SHALL classify remote-deleted + commits-not-reachable-from-base as squash-merge unreachability, not as a git/network/auth hard failure. Automatic release after proven merge SHALL consume bound proof through this same ladder, not a path-local mole.
- `integrated-train-mode`: After `train --merge` proves a merge result is contained in the fetched base, park-release SHALL use the same bound-proof gate as `/pipeline` / `pipeline single`. Train SHALL NOT keep a clean managed worktree solely because post-squash SHAs are not reachable from the base.

## Impact

- **Shared gate:** `core/scripts/worktree.ts` (`checkLocalOnlyCommits`, `evaluateRemoveSafety`, `removeManagedWorktreeSafely`, `releaseWorktreeForParkedIssue`). Callers: `deploy_ready` terminal removal, `maybeReleaseWorktreeOnPark` / `/pipeline` / `pipeline single`, and `train --merge` after `merge_result_oid` is proven in `origin/<base>`.
- **Proof input:** park-release MUST accept bound proof (issue, PR, base, `merge_result_oid` already proven contained). Proof for a different identity MUST NOT release this tree.
- **Tests:** injected I/O only. A regression MUST fail if, given bound proof and a clean managed worktree, park-release retains and emits git/network/auth. Separate cases: dirty retain, filesystem-failure retain without label change, no-proof squash-merge retain with the existing not-reachable message, mismatched proof identity retain.
- **Docs:** operator-facing park-release text MUST distinguish bound-proof release from true git/network/auth and from squash-merge unreachability without proof.
- **Out of scope:** merge policy; squash vs merge-commit; merge inside advance/loop; auto-merge; making `/pipeline:cleanup` the required fix; forced dirty deletion except existing `--force`; other retain reasons (live branch with unproven commits, in-progress work); cross-host worktree locking.

## Acceptance criteria

Observable, falsifiable outcomes that make #1274 done:

- [ ] Given a squash merge for issue N and PR P onto the configured base, and a `merge_result_oid` the engine has proven is contained in `origin/<base>` for that same N, P, and base: when the managed worktree is clean, park-release removes that worktree from `worktree_root`.
- [ ] On that proven-merge path, operator-visible text does not contain `commit verification failed (git/network/auth error)` and does not tell the operator to check connectivity or retry.
- [ ] Proof bound to a different issue number, PR number, base branch, or merge-result OID does not release this worktree.
- [ ] If filesystem cleanup fails after that proven merge, only that worktree is kept, the reported reason is the filesystem/cleanup error (not git/network/auth), and `pipeline:ready-to-deploy` / integrated state does not change.
- [ ] If the managed worktree is dirty after that proven merge, the worktree is kept, the reported reason names the dirty worktree (not git/network/auth), and `pipeline:ready-to-deploy` / integrated state does not change.
- [ ] If the remote branch is deleted and the engine does not have bound merge-result proof in `origin/<base>`, the worktree is kept and the reason names commits not reachable from the base (existing squash-merge/`--force` wording). The reason is not git/network/auth.
- [ ] `/pipeline` / `pipeline single` and `train --merge` use the same release gate. An injected test that models the next identical post-squash-merge case passes through that gate without a caller-specific mole.
- [ ] Unit tests inject I/O (no live network, git, or subprocess). At least one test fails without the fix: bound proof + clean tree + post-squash unreachability currently retains with git/network/auth.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `openspec validate park-release-bound-merge-proof` and `npm run ci` pass.
