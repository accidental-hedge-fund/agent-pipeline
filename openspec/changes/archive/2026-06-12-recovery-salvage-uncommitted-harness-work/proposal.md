## Why

When an implementer, fix, or test-fix harness does the work but exits without committing, the pipeline hard-blocks with "No commits found in the range" and the completed change is lost unless a human intervenes manually. Salvaging the uncommitted work (staging + committing it with traceability trailers) recovers verified developer output that the pipeline currently discards.

## What Changes

- `core/scripts/stages/planning.ts` and `fix.ts`: before blocking on the "no new commits" path, check whether the worktree is dirty; if dirty, invoke a new `salvageUncommittedWork` helper to stage and commit the leftover changes with proper traceability trailers and the appropriate commit-message format for that stage.
- New `core/scripts/salvage-harness-work.ts`: the `salvageUncommittedWork` function that does `git add -A` + `git commit` with a salvage message, `Issue:` and `Pipeline-Run:` trailers, and an attributing note that the commit was pipeline-salvaged.
- `core/scripts/verify-harness-commits.ts`: the `VerifyDeps` seam gains an optional `gitSalvage` injectable so the salvage is testable without real subprocess calls (alternatively the seam lives in the stage callers — implementation decides; intent is the seam is injectable).

## Capabilities

### New Capabilities
- `harness-uncommitted-salvage`: When a harness step exits leaving uncommitted changes in the worktree but no new commit in its range, the pipeline SHALL stage and commit those changes with traceability trailers before proceeding to the test gate, rather than blocking.

### Modified Capabilities
- `harness-step-verification`: The "no commits found in range" block path SHALL be preceded by a dirty-worktree check; a non-empty worktree triggers salvage rather than an immediate block.

## Impact

- `core/scripts/stages/planning.ts`, `core/scripts/stages/fix.ts`: add salvage pre-pass at each "no new commit" block site.
- New `core/scripts/salvage-harness-work.ts` (and co-located `salvage-harness-work.test.ts`).
- `core/scripts/verify-harness-commits.ts`: minor seam extension (or no change if the seam lives at call sites).
- `auto_recover.ts` is unchanged — it handles the genuinely-empty (clean worktree) path and continues to delete-and-retry there.
- No config keys, CLI changes, state-machine edges, or review/SHA-gate contracts are affected.
