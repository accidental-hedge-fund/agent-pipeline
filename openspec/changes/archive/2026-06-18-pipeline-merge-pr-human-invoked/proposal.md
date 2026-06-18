## Why

The pipeline-desk "Merge" button has no backend — there is currently no merge capability in the skill, so a pipeline operator must leave the tool to merge a ready PR. The merge logic should live once, in the skill, invoked explicitly by a human (or by pipeline-desk on a human button click); the autonomous `advance` loop must never call it (CLAUDE.md rule #4, `pipeline-state-machine` spec).

## What Changes

- Add `pipeline merge <pr-number>` as a new human-only sub-command peer to `release`, `intake`, and `sweep`.
- The command squash-merges the target PR and deletes its head branch, but **only** when all safety gates pass (PR is `MERGEABLE`/`CLEAN`, required checks pass, linked issue is at `pipeline:ready-to-deploy`).
- On gate failure the command refuses with a clear, actionable error message identifying the specific blocker (not-mergeable / failing-checks / conflicts / wrong stage).
- The autonomous `advance` loop is explicitly excluded from ever calling this path; a unit test asserts no merge call occurs on any stage transition.
- No `auto_merge` config key is introduced; no auto-merge path exists anywhere.
- All merge I/O is behind a DI `deps` seam so unit tests make no real network or subprocess calls.

## Capabilities

### New Capabilities

- `merge-sub-command`: Human-invoked `pipeline merge <pr>` that squash-merges a ready-to-deploy PR with full safety gate validation; structurally isolated from the autonomous advance loop.

### Modified Capabilities

- `pipeline-state-machine`: Add an explicit structural guarantee that `merge` is loop-isolated — the never-auto-merge invariant is extended to cover the new sub-command as a human-only surface.

## Impact

- **`core/scripts/pipeline.ts`** — add `merge` to the recognized sub-commands list; dispatch to new handler.
- **`core/scripts/stages/merge.ts`** (new) — merge handler with DI deps seam (`MergeDeps`); reads PR state, validates gates, calls `gh pr merge`.
- **`core/test/merge.test.ts`** (new) — unit tests for gate logic and loop-isolation assertion.
- **`plugin/`** — regenerated mirror (no hand-edits).
- No config schema changes; no new config keys.

## Acceptance Criteria

- [ ] `pipeline merge <pr>` squash-merges and deletes the branch when the PR is `MERGEABLE`/`CLEAN` with all required checks passing.
- [ ] Refuses (non-zero exit, actionable message) when PR is not mergeable, has failing checks, has conflicts, or the linked issue is not at `pipeline:ready-to-deploy`.
- [ ] A unit test asserts that no merge call occurs on any stage transition in the autonomous `advance` loop (loop-isolation guarantee).
- [ ] No `auto_merge` config key or auto-merge path is introduced.
- [ ] All merge I/O is behind a `MergeDeps` seam; unit tests make no real network, git, or subprocess calls.
- [ ] `npm run ci` passes with the new code and tests.
