## Why

`createWorktree` reclaims an issue's existing managed worktree(s) before capacity checks and re-create by calling `removeWorktree`, which always runs `git worktree remove --force` and `git branch -D` with `ignoreFailure: true`. That path has **no dirty-tree or local-only-commit gates**, so a retry, title/slug change, or self-reclaim silently destroys uncommitted harness work and unpushed local commits. Operators re-running an issue reasonably expect prior recoverable work to be refused or preserved — the same guarantees `removeWorktreeForIssue` already provides for `--remove-worktree`.

## What Changes

- **Reclaim uses the same safety ladder as operator remove.** Before any destructive reclaim mutation, the create path SHALL check dirty workdir state and local-only (unpushed) commits using the same semantics as `removeWorktreeForIssue` / `worktree-per-run-removal`.
- **Refuse, never silent force-delete, when recoverable work remains.** Dirty worktrees and definitive / unverifiable / verification-failed local-only commit results block reclaim with a clear, actionable error. Create aborts; the existing worktree and branch are left intact.
- **Clean reclaim still proceeds.** When a managed candidate is clean and has no local-only commits (same conditions under which operator remove without `--force` would succeed), reclaim may remove the worktree and local branch so create can continue.
- **Out-of-managed-root skip stays.** Records with `underManagedRoot === false` continue to be skipped (not reclaimed), as today.
- **No new operator flags.** Reclaim is not an interactive force path; it does not invent a create-time `--force` to discard dirty work. Operators who intentionally want discard continue to use `pipeline N --remove-worktree --force` (subject to existing local-only tiers).

## Capabilities

### New Capabilities

- _(none)_ — this is a safety hardening of existing create/reclaim behavior.

### Modified Capabilities

- `worktree-lifecycle`: The "stale path reclaimed" / create-time reclaim behavior MUST NOT force-delete managed worktrees that still have recoverable dirty or local-only work; reclaim MUST share (or equivalently enforce) the operator remove safety gates and fail closed with a clear error.

## Impact

- **Code:** `core/scripts/worktree.ts` — `createWorktree` reclaim loop and the shared remove primitive / deps seams used for dirty and local-only checks; likely a shared pre-remove safety helper so reclaim and `removeWorktreeForIssue` cannot drift.
- **Tests:** New regression coverage for dirty reclaim and local-only-commit reclaim (fail closed); clean reclaim still succeeds. Existing `worktree-remove` / create-worktree tests stay green.
- **Callers:** Only the create-time reclaim path is in scope. Eval `createWorktreeAt` isolation, multi-host lock doctrine, and terminal/auto-recover removals that call the low-level `removeWorktree` after stage completion are out of scope unless they already share the same primitive (they must not regress).
- **Mirror:** After `core/` changes, regenerate `plugin/` via `node scripts/build.mjs` in the same commit; `npm run ci` must pass.
- **Related history:** Operator remove tiers (#296 / `worktree-per-run-removal`); salvage of uncommitted harness work (#521-family / `harness-uncommitted-salvage`); sweep dirty skip (`worktree-stale-cleanup`).

## Acceptance criteria

Observable, falsifiable outcomes that make #622 done:

- [ ] When `createWorktree` would reclaim a managed on-disk worktree for the same issue that has a dirty working tree (`git status --porcelain` non-empty), reclaim **does not** invoke `git worktree remove` / `git branch -D`, the directory and branch remain, and the create path fails with an error that names the dirty condition (and issue / path or branch).
- [ ] When that candidate has definitive local-only (unpushed) commits, reclaim likewise **does not** remove the worktree or delete the branch, and create fails with an error naming the local-only condition.
- [ ] When local-only verification is `"unverifiable"` or hard-fails (`null` / git-network error), reclaim refuses without mutation (same fail-closed posture as operator remove without a successful clean verification).
- [ ] When the candidate is clean and has no local-only commits, reclaim still removes it and create proceeds (retry / slug-change / self-reclaim capacity path continues to work).
- [ ] Out-of-managed-root records (`underManagedRoot === false`) remain unreclaimed (no force-delete of developer checkouts).
- [ ] Unit tests cover at least: dirty reclaim refusal, local-only reclaim refusal, clean reclaim success; tests inject I/O via deps and would fail if reclaim called the remove seam without gates.
- [ ] `npm run ci` is green; if `core/` changed, `plugin/` is regenerated in the same change set.
