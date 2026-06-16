## Context

Two independent convergence bugs in `pre_merge.ts`:

**Bug 1 — archive re-entry**: `maybeArchiveOpenspec` computes `candidates` by diffing `origin/<base>...HEAD` and filtering by `changeDirExistsFn`. On a successful first archive `openspec/changes/<id>/` is moved to `openspec/changes/archive/<date>-<id>/` locally, and the diff's net change no longer contains the original path — so `candidates` should be empty. However, a `git status --porcelain` empty-exit path (`if (!status.stdout.trim()) return null`) can return `null` (continue) without producing a `waiting` return, so the archive step re-runs on the next poll with a non-empty candidates list. Additionally, external worktree state can diverge from the committed state in edge cases. The robust fix is an explicit "already archived?" guard that reads the branch's commit log rather than relying on filesystem state.

**Bug 2 — CI persistent failure**: the `advancePolling` loop calls `advance()` until it advances, blocks, or times out. On a CI failure `advance()` tries a rebase (marking the attempt), returning `waiting`. On the NEXT call, `rebaseAlreadyAttempted` is true and the code falls through to `setBlocked` — this path is already present. But in practice a no-op rebase (base branch unchanged) still marks the attempt, and the second CI-failure check path does block. The true issue is that the `waiting` result from the first CI-failure iteration causes the loop to continue rather than surface the failure early. The fix ensures the gate blocks as soon as CI has failed and the auto-repair window has been exhausted.

## Goals / Non-Goals

**Goals**
- Archive runs at most once per issue per pre-merge sequence, regardless of how many polling iterations run.
- A definitively-failing CI (failed checks, rebase guard exhausted or rebase impossible) routes to `blocked` / `needs-human` on the same polling iteration, not on the next one.

**Non-Goals**
- Changing the rebase strategy or conflict detection (those are `pre-merge-conflict-detection`).
- Fixing the underlying CI failure (that is for the implementer).
- Changing the state-machine edges or any other stage.

## Decisions

**Decision: archive-already-done check reads `git log`, not the filesystem.**
`changeDirExistsFn` is a filesystem check that can be inconsistent with committed state. The branch commit history is authoritative: if the branch has a commit whose headline starts with `OPENSPEC_ARCHIVE_PREFIX` plus the issue number, the archive was already committed and pushed. This is computed via `git log --format=%s origin/<base>..HEAD` in the worktree — a fast local operation with no network call. The check is injected as `archiveAlreadyDone` in `AdvancePreMergeDeps` so it is unit-testable with a fake.

**Decision: CI-failure block uses `needs-human` label.**
`test-gate-exhausted` is for the local test-gate loop. The pre-merge CI failure is different: a GitHub CI run on the pushed branch produced a definitive failure the pipeline cannot auto-fix. `needs-human` is the correct label — a human must fix the failing CI check and re-push.

**Decision: block immediately when rebase attempt is exhausted AND CI is still failing.**
Returning `waiting` after marking the rebase attempt means the polling loop goes around one more time before blocking. We tighten this: when `agg.failed.length > 0` and `alreadyRebased`, call `setBlocked` + return `blocked` immediately. Same for a failed rebase (`ok === false`).

**Decision: deps/fake seam for `archiveAlreadyDone`.**
Mirrors the existing seam pattern (`gitInWorktree`, `openspecArchive`, etc.) in `AdvancePreMergeDeps`. The default implementation reads `git log`; tests inject a fake returning `true`/`false`.
