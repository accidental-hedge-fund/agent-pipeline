## Why

`setBlocked` appends the same "`--unblock`" instruction to every blocker, but `--unblock` only clears the label — it does not re-run, fix, rebase, or recover anything. For ~12 structurally-distinct blocker kinds (test-gate exhaustion, no-commits, merge conflict, harness crash, OpenSpec invalid, PR-creation failure, …) the hint directs operators to the wrong verb, causing confusion and wasted steps (the canonical trap: `--unblock` on a no-commits block without the salvage path from #131).

## What Changes

- A closed enum `BlockerKind` is added to `types.ts` covering every distinct blocker class.
- `setBlocked` gains an optional `kind` parameter (defaults to `needs-human` for backward-compat); the "## Pipeline: Blocked" comment renders a kind-specific "### How to unblock" recipe instead of the uniform `--unblock` hint.
- Every existing `setBlocked(...)` call site is updated to pass the correct `BlockerKind`.
- A snapshot/string test pins each kind's rendered recipe text so stale recipe strings are caught at CI time.

## Capabilities

### New Capabilities
- `blocked-recovery-recipes`: Per-kind recovery recipe rendering in `setBlocked` — closed `BlockerKind` enum, kind-specific "### How to unblock" text in the blocked comment, call-site wiring, and regression snapshot tests.

### Modified Capabilities
- `pipeline-state-machine`: The blocked-state requirement is extended: the "How to unblock" section of a blocked comment SHALL now be kind-specific, drawn from a closed `BlockerKind` enum.

## Impact

- `core/scripts/types.ts` — new `BlockerKind` enum
- `core/scripts/gh.ts` — `setBlocked` signature + comment body template
- `core/scripts/stages/planning.ts`, `fix.ts`, `pre_merge.ts` — call-site updates
- `core/test/gh.test.ts` (or a new `blocked-recipes.test.ts`) — snapshot tests per kind
- No behavior/authority change: still only posts a comment + `blocked` label
