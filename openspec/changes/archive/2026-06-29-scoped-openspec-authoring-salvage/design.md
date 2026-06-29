# Design

## Context

`salvageUncommittedWork` (#131) rescues harness work that exits uncommitted: when the harness range
is empty (`headAfter === headBefore`) but the worktree is dirty, the pipeline stages and commits the
leftovers so downstream verification validates them instead of discarding them with "No commits
found in the range". The salvage stages everything via `git add -A -- :(exclude)node_modules` (the
`:(exclude)node_modules` pathspec was added by #180).

The OpenSpec authoring step is the one salvage caller with a **narrower commit contract** than "all
changed files": its guard `verifyHarnessCommits(..., { allowPattern: /^openspec\// })` blocks the
stage if the harness commit touches anything outside `openspec/`. When the authoring harness leaves
work uncommitted, the generic salvage stages `tasks/todo.md` (or any other dirty file) alongside the
`openspec/changes/<id>/` change, and the guard then blocks the salvage commit — issue #321.

## Decision: scope the salvage staging (Option A), not the sandbox (B) or a restore (C)

The issue lists three options. We take **Option A** — scope the authoring salvage to `openspec/` —
because it fixes the actual inconsistency: the salvage path and the authoring guard must agree on
what is committable at the authoring stage.

- **Why not Option B (change the Codex sandbox to allow git index writes).** The sandbox lock is
  *a* trigger, not *the* defect. The defect is that salvage over-commits relative to the stage's
  guard; any harness that exits uncommitted for any reason (crash, timeout-after-write, a future
  harness) reproduces it. `harness_sandbox` is also a configurable policy with its own spec
  (`harness-sandbox-mode`) and broader blast radius across every stage — out of scope here. The
  sandbox tuning can be pursued separately; it would not make the salvage scope-correct.
- **Why not Option C (`git restore .` before salvage).** Restoring tracked files before salvage is
  destructive — it discards the harness's `tasks/todo.md` (and any other tracked edit) rather than
  merely declining to commit it. Scoping the staging achieves the same committed result without
  touching the worktree's other files. The pipeline never needs those notes committed; leaving them
  dirty is harmless and reversible.

## Decision: an optional, default-off scope parameter

The scope is threaded as an **optional** pathspec through
`salvageUncommittedWork(scope?)` → `trySalvageUncommittedWork(scope?)` →
`salvageIfNoNewCommit(scope?)`. Absent ⇒ today's exact behavior
(`git add -A -- :(exclude)node_modules`, unscoped status). Only the OpenSpec authoring call site
passes `openspec/`. This keeps the implement / fix-round / test-fix salvage paths byte-for-byte
unchanged and confines the new behavior to the one stage with the narrower contract — minimal
diff, no risk to the other salvage callers.

## Decision: scope the dirtiness check as well as the staging

`salvageUncommittedWork` currently returns `{ salvaged: false }` when `git status --porcelain` is
empty. With a scope set, the status check is **also** scoped (`git status --porcelain -- <scope>`),
so a worktree dirty only *outside* the scope is treated as "nothing to salvage" — no commit is
created. This matters for the no-change-authored case: when the harness wrote only `tasks/todo.md`
and produced no `openspec/changes/<id>/` directory, the scoped salvage no-ops and the stage falls
through to its existing `enforceOpenspecChangeSingular` block ("produced no change under
`openspec/changes/`"). Without scoping the status, the salvage would attempt an empty `git add` +
`git commit`, which would fail noisily (nothing staged) and be swallowed by the non-throwing
wrapper — same end state but with confusing failure noise. Scoping the status makes the no-op
deterministic and clean.

## Behavior summary

| Worktree state after authoring harness (no new commit) | Scoped salvage result | Stage outcome |
| --- | --- | --- |
| `openspec/changes/<id>/` + modified `tasks/todo.md` | commit only `openspec/`; `tasks/todo.md` left dirty | guard passes → advance |
| only `openspec/changes/<id>/` | commit only `openspec/` | guard passes → advance |
| only modified `tasks/todo.md` (no change on disk) | no commit | existing "no change created" block |
| clean | no commit | existing block/auto-recover path |

## Test seams

The existing `SalvageDeps` seam (`gitStatus`, `gitAddAll`, `gitCommit`) already supports the new
behavior: tests assert the `gitAddAll` args include the `openspec/` scope and that the scoped
`gitStatus` drives the no-op path. No new I/O surface is introduced. The new tests mirror the
existing `salvage-harness-work.test.ts` contract tests (including the `verifyHarnessCommits`
authoring-gate assertion at line 154) and must bite: removing the scope re-introduces the
`tasks/todo.md` file into the salvage commit and re-triggers the path-constraint block.
