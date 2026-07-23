## Context

`trySalvageUncommittedWork` (`core/scripts/salvage-harness-work.ts`, #131) recovers a
harness step that leaves complete work in the worktree but exits without committing: it
stages `git add -A` (minus a depth-agnostic `node_modules` exclusion) and commits the
leftover. `pre_merge.ts` writes a transient marker file, `.pipeline-rebase-attempted`
(`REBASE_MARKER_FILE`), to the worktree root to enforce a one-time auto-rebase bound. The
marker is host-local coordination state, read back with `fs.existsSync`; it should never
be committed. Because it is not gitignored, `git status --porcelain` reports it, and when
it is the only dirty path a later salvage stages and commits it as the round's entire
content (observed on lyric-utils#638).

## Goals

- Never produce a salvage commit whose content is (only) a pipeline-internal marker file.
- Keep salvage of genuine uncommitted work — including work that happens to sit next to a
  marker — unchanged.
- Single-source the marker filename so the exclusion and the writer cannot drift.

## Decision 1 — Exclude at the salvage path, not via `.git/info/exclude`

`node_modules` is excluded two ways: written to `.git/info/exclude` at worktree bootstrap
(so `git status --porcelain` never reports it) **and** an explicit `git add` pathspec
(belt-and-suspenders). We deliberately do **not** add the marker to `.git/info/exclude`.

- The issue is scoped to the salvage staging path; the bootstrap exclude is a separate
  capability edge, and expanding it would broaden the change beyond the reported defect.
- `.git/info/exclude` resolves through the **common** git dir shared across every worktree
  of the repo (see `realWriteNodeModulesExclude`), so writing the marker there would alter
  ignore behavior for the operator's primary checkout too. Keeping the fix inside the
  salvage path confines the behavior change to salvage.

Consequence: unlike `node_modules`, the marker **is** reported by `git status --porcelain`,
so excluding it only at `git add` time is insufficient — a marker-only worktree would read
as dirty, salvage would proceed, `git add` would stage nothing (marker excluded), and
`git commit` would fail (or, if the exclusion were only partial, commit the marker). The
dirtiness check must therefore also ignore the marker.

## Decision 2 — Exclude the marker in BOTH the status check and the add

Two coordinated changes in `salvage-harness-work.ts`:

1. **Dirtiness check** — `git status --porcelain` (the unscoped `defaultGitStatus` and the
   scoped variant) restricts its pathspec to exclude the marker, e.g.
   `git status --porcelain -- . :(exclude,glob)**/.pipeline-rebase-attempted`. An explicit
   `.` is included because an exclude-only pathspec does not reliably imply "everything
   else" for `git status`. A worktree whose only dirty entry is the marker then reports
   empty → `salvageUncommittedWork` returns `{ salvaged: false }` and the caller keeps its
   existing block / auto-recover path.
2. **Staging** — the marker exclusion pathspec is added to both the unscoped
   `SALVAGE_GIT_ADD_ARGS` and the scoped add-args, alongside `SALVAGE_NODE_MODULES_EXCLUDE`.
   This guarantees the marker is never staged even when it coexists with real changed files.

Both use a **depth-agnostic** glob (`:(exclude,glob)**/.pipeline-rebase-attempted`) to
match the robustness of the node_modules exclusion, even though the marker is written only
at the worktree root today.

## Decision 3 — Single-source the marker filename

Add an exported `PIPELINE_INTERNAL_MARKER_FILES` (currently `[".pipeline-rebase-attempted"]`)
in `salvage-harness-work.ts`, and have `pre_merge.ts`'s `REBASE_MARKER_FILE` refer to it.
This is the one place both the writer and the salvage exclusion read the filename from, so a
future rename or a second marker cannot silently desynchronize them. Because type-stripping
runs no `tsc` check (CLAUDE.md), a runtime drift-guard test asserts the two stay aligned.

## Risks / trade-offs

- A future pipeline-internal marker that a harness *does* legitimately want committed would
  need to be kept out of `PIPELINE_INTERNAL_MARKER_FILES`; the list is intentionally narrow
  (transient coordination markers only).
- The status pathspec must include the explicit `.`; a regression test with a marker-only
  worktree proves the empty-status path bites, guarding against an exclude-only pathspec
  that silently matches nothing.
