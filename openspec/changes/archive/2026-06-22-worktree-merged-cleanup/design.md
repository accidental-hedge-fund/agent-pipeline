## Context

The pipeline has two existing worktree-removal paths:

1. **`pipeline --cleanup`** (`sweepMergedWorktrees` in `worktree.ts`): bulk sweep of all pipeline-managed worktrees whose PR is merged. Silently skips dirty worktrees with reason `"uncommitted changes"`. Only acts on merged PRs.
2. **`deploy_ready` terminal stage**: removes the worktree when an issue reaches `pipeline:ready-to-deploy` — before the human merges.

Pipeline Desk issue #164 ("cleanup worktrees from the UI") needs a third path: remove **one specific issue's** worktree, **regardless of merge state**, and surface dirty state so the UI can warn-and-confirm rather than silently skip. The existing `--cleanup` cannot be retrofitted for this:
- It is bulk (no way to target a single issue).
- It is merged-only (skip condition is hardcoded to `!mergeState.merged`).
- It silently skips dirty worktrees without giving the caller a hook to confirm.

## Goals / Non-Goals

**Goals:**
- Add a targeted per-issue removal mode (`pipeline N --remove-worktree`) that Pipeline Desk can invoke for a single run.
- Surface dirty state as a structured error so callers can prompt for confirmation before a forced removal.
- Keep the implementation minimal and consistent with the existing bypass-path pattern (`--status`, `--unblock`, `--override`).
- All new I/O behind an injectable-deps seam so the logic is fully unit-testable.

**Non-Goals:**
- Replacing or modifying the bulk `--cleanup` (it remains unchanged for its "post-batch sweep" use case).
- Touching the remote branch (neither push, delete, nor force-push — matching `removeWorktree` today).
- Auto-triggering removal on merge without a human invocation.
- Adding a new top-level sub-command (unnecessary complexity; `--remove-worktree` fits the bypass-path pattern).

## Decisions

**Decision: `pipeline N --remove-worktree` flag, not a new sub-command.**
`release`, `intake`, `sweep` are sub-commands because they take no issue number and need custom argument parsing. `--remove-worktree` targets a specific issue N, so the existing `pipeline N` dispatch is the natural fit. It follows the established bypass-path pattern: parse the flag early, call the handler, return — no pipeline-advance logic runs. This avoids a new dispatch case and keeps the CLI surface minimal.

**Decision: `--force` without `--force` exits non-zero on dirty; with `--force` removes anyway.**
The goal is to give the caller (Pipeline Desk) a two-step flow: first call without `--force` → get a non-zero + dirty info → show warning dialog → call again with `--force`. This mirrors git's own `--force` convention and avoids pipeline silently destroying work. The `--force` modifier is scoped to `--remove-worktree` mode; using it without `--remove-worktree` is a usage error.

**Decision: `--json` emits a flat object, not a list.**
Per-issue removal always targets exactly one worktree, so a list envelope would be empty or singular — always. A flat object with `removed`, `dirty`, `branch`, `worktree`, `error` is simpler and unambiguous for Pipeline Desk to parse.

**Decision: bypass the kill switch.**
`--remove-worktree` is a maintenance/recovery action. A kill switch active during a stuck run is precisely when an operator most needs to clean up worktrees. Same policy as `--unblock` and `--override`.

**Decision: `removeWorktreeForIssue` in `worktree.ts`, not inline in `pipeline.ts`.**
The removal logic (find worktree, check dirty, remove) involves multiple I/O operations that must be unit-testable in isolation. Putting it in `worktree.ts` behind a `RemoveWorktreeDeps` interface (same pattern as `SweepDeps`, `CreateWorktreeDeps`) keeps `pipeline.ts` as a thin dispatcher and keeps worktree logic co-located.

**Decision: not-found is a non-zero exit, not a silent success.**
If `pipeline N --remove-worktree` is called and there is no worktree for issue N, the caller likely has a bug or stale state. Exiting non-zero with a clear message surfaces this rather than silently succeeding. `--json` includes `"removed": false, "error": "no worktree found for issue N"`.

## Risks / Trade-offs

- *`--force` removes uncommitted work irreversibly* → The non-force path surfaces the dirty state explicitly; operators must opt in. The `--json` response includes `dirty: true` so Pipeline Desk can gate on a UI confirmation before retrying with `--force`.
- *Two concurrent callers racing `--remove-worktree N`* → Second caller hits not-found after first removes; exits non-zero with not-found. Acceptable given the low frequency; the current `removeWorktree` function already uses `ignoreFailure` for git operations.
- *`git worktree remove` may refuse on dirty even without our dirty check* → Our pre-check surfaces a structured error before git even runs, so the caller gets a parseable reason rather than a raw git error message. Belt-and-suspenders.
- *No mutex around the removal* → The worktree-creation mutex (`worktreeMutexPath`) serializes `git worktree add` only. Removal does not need a mutex because it is a single-writer operation and git's own locking handles the directory-level race.

## Open Questions

- Should `--remove-worktree` also be accessible as `pipeline remove-worktree N` (sub-command form) for symmetry with `pipeline sweep`, `pipeline intake`, etc.? Decision deferred to implementation; the spec does not preclude adding a sub-command alias later.
