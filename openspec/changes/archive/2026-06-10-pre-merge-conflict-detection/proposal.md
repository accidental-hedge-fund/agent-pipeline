## Why

When a PR becomes `CONFLICTING` with the base branch, GitHub cannot build the `pull_request` merge ref and never creates CI check runs. The pre-merge stage's CI poll sees zero (or error-throwing) checks, treats it as "pending", and loops until `ci_timeout` (default 900 s) — at which point it blocks rather than auto-rebasing. The recovery path (`tryRebaseAndPush`) already exists and is used after CI *failures*, but it is never reached because conflict detection only happens *after* the CI step, which never exits pending.

## What Changes

- Pre-merge gains a mergeability pre-check that runs **before** the CI poll begins.
- When the pre-check detects `mergeable == CONFLICTING` / `mergeStateStatus == DIRTY`, the gate skips the CI poll entirely and routes to the existing `tryRebaseAndPush` path.
- The same `rebaseAlreadyAttempted` marker guard used in the CI-failure rebase path is applied to the early-conflict path as well, preventing an infinite rebase loop when the conflict cannot be auto-resolved.
- If the rebase cannot be resolved automatically, the item blocks with a clear "merge conflict — manual rebase needed" message instead of a generic CI-timeout or CI-failure reason.
- The "no checks reported" case for repos that genuinely have no CI workflow is unaffected — that path is only taken when the PR is **not** CONFLICTING.

## Capabilities

### New Capabilities

- `pre-merge-conflict-detection`: The pre-merge gate SHALL detect a CONFLICTING PR early (before the CI poll) and route to the rebase path rather than hanging until ci_timeout.

### Modified Capabilities

<!-- None: no existing spec-level requirements change. -->

## Impact

- `core/scripts/stages/pre_merge.ts` — add early mergeability check before the CI poll block.
- `core/test/pre-merge-conflict-detection.test.ts` (new) — regression test proving a CONFLICTING-PR fixture drives the rebase path, not CI-timeout.
- `plugin/` — regenerated mirror (no hand edits).
