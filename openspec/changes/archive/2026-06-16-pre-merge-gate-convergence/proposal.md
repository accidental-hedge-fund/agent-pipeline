## Why

The pre-merge gate has two convergence bugs that cause it to burn its full iteration budget on a run that will never advance: (1) `maybeArchiveOpenspec` re-runs the archive step on every polling iteration even after the archive commit was already pushed, and (2) a persistently-failing CI (e.g. clippy `-D warnings`) is never surfaced as a hard block — the gate loops until `ci_timeout` rather than routing to `needs-human`. Both were observed live on pipeline-desk issue #21 after review-2 had approved.

## What Changes

- `core/scripts/stages/pre_merge.ts` — `maybeArchiveOpenspec`: add a once-per-branch guard; before attempting `openspec archive`, check whether the branch already contains a pipeline-internal archive commit (a commit whose headline starts with `OPENSPEC_ARCHIVE_PREFIX` for this issue); if so, skip the archive step entirely and return `null` (proceed).
- `core/scripts/stages/pre_merge.ts` — CI-failure path: when CI checks definitively fail AND the auto-rebase guard is exhausted (or the rebase itself failed), the gate SHALL immediately call `setBlocked` with `needs-human` label and the list of failing check names — it SHALL NOT return `waiting` a second time on the same persistent failure.
- Co-located unit tests for both new behaviors via the existing `AdvancePreMergeDeps` seam.

## Capabilities

### New Capabilities
- `pre-merge-ci-gate`: the pre-merge CI polling gate behavior — when CI check runs definitively fail and the rebase guard is exhausted, the gate SHALL block with `needs-human` and surface the failing check names.

### Modified Capabilities
- `openspec-integration`: the archive step gains an idempotency guard — if a pipeline-internal archive commit already exists on the branch for this issue, the archive step SHALL be skipped on all subsequent polling iterations.

## Impact

- `core/scripts/stages/pre_merge.ts` and its co-located tests (`core/test/`).
- No changes to the state-machine edges, other stages, or any other file.
