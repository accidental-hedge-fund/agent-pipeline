## Why

When a pipeline run blocks during the `implementing` stage (e.g. the test gate exhausts its attempts, or git push fails, or PR creation fails), unblocking the item and re-running does nothing: the dispatch table treats `implementing` as a transient, intra-run label with no resumable entry point, logging "nothing to do at this point." The only recovery is a full manual takeover — push the worktree branch by hand and open the PR manually — which defeats the purpose of `--unblock` and makes `implementing` the single most impactful block location in the pipeline.

## What Changes

- The `implementing` case in `dispatch()` (`pipeline.ts`) gains a **resumable path**: when a worktree exists for the issue AND has commits ahead of the base branch AND no PR exists yet, the pipeline SHALL re-run the post-implementation steps (test gate → push → open PR → transition to `review-1`) without re-planning or re-implementing.
- A new `resumeFromImplementing()` function in `planning.ts` encapsulates the gate+push+PR logic, callable from the dispatch resume path as well as from the existing end of the standard and OpenSpec implementing flows.
- The dispatch `implementing` case falls back to the existing "nothing to do" response when no resumable worktree is found (preserving the current behavior for items that are mid-flight in the same run).
- `auto_recover.ts` is unchanged — it handles the orthogonal case of `implementing + blocked` with no commits (implementer produced nothing), which is a distinct failure mode.

## Capabilities

### New Capabilities
- `implementing-resume`: Re-entry behavior for the `implementing` stage when an implementation commit exists in the worktree but the post-implementation steps (gate/push/PR) were not completed.

### Modified Capabilities
- `pipeline-state-machine`: The `implementing` dispatch case changes from an unconditional "waiting" return to a conditional check — resume if commits exist, otherwise wait.

## Impact

- `core/scripts/pipeline.ts` — `dispatch()` `implementing` case.
- `core/scripts/stages/planning.ts` — extract shared `resumeFromImplementing()` (gate + push + PR + transition), callable from both the existing standard/OpenSpec flows and the new dispatch resume path.
- `core/test/` — unit tests for the resume path via the `AdvanceReviewDeps` / `ShaGateDeps` dependency seams.
- `plugin/` mirror (regenerated; no hand-edits).

## Acceptance Criteria

- [ ] Re-running `/pipeline N` when the issue is at `implementing` (unblocked) and a worktree with commits exists advances to `review-1` (and opens a PR if one does not yet exist) without re-planning or re-implementing.
- [ ] Re-running `/pipeline N` when the issue is at `implementing` (unblocked) and **no** worktree with commits exists returns the same "nothing to do" response as today (no regression for the mid-flight case).
- [ ] The test gate runs as part of the resume path; if it fails again, `setBlocked` is called and the run halts (the resume path does not bypass the gate).
- [ ] If a PR already exists for the issue when resuming, the pipeline re-uses the existing PR number rather than attempting to create a duplicate.
- [ ] The transition `implementing → review-1` is posted exactly once whether the PR was created fresh or found from a prior partial run.
- [ ] `auto_recover.ts` behavior is unchanged: a blocked `implementing` with no commits still resets to `ready` via the existing path.
- [ ] `npm run ci` passes end-to-end after the change.
