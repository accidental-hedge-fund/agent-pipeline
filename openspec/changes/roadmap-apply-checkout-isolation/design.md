## Context

`openRoadmapPr` (`core/scripts/roadmap/writeback.ts`) is the only path that publishes
`docs/roadmaps/<repo>.md` when `config.roadmap.pr_docs` is true. Today it:

1. Derives a **day-keyed** branch: `roadmap/<repoSlug>-YYYY-MM-DD` from `plan.generated_at`.
2. If `findPrByHead(repo, branch)` finds an open PR → **return that URL immediately**
   (no content comparison, no update).
3. Else if local `docs/roadmaps/<repo>.md` on the **operator checkout** equals the new
   render → no-op.
4. Else `gitCreateBranch(repoDir, …)` or `gitSwitchBranch(repoDir, branch)`, write the
   file into `repoDir`, commit with **hardcoded** `Issue: #171` +
   `Pipeline-Run: 171/2026-06-17T04:37:16Z`, push, create PR.

Step 2 freezes stale roadmap content for the rest of the calendar day once a PR exists.
Step 4 mutates the operator’s checkout (and the “must call `gitSwitchBranch`” regression
test in `roadmap-writeback.test.ts` **locks that defect in**). The hardcoded trailers are
paste fossils from the original #171 feature PR; `roadmap` is a no-issue-number command
and has no legitimate default issue.

Related: issue-scoped managed worktrees (`core/scripts/worktree.ts`) already isolate
pipeline advance work; intake still switches branches on a clean `repoDir` (different
command, different contract — not in scope). Commit trailer helpers live in
`core/scripts/traceability.ts` (`withTrailers`, `makePipelineRunId`).

## Goals / Non-Goals

**Goals:**

- Operator checkout is never branch-switched, rebased, or written to for roadmap docs PR
  writeback.
- Existing day-branch PRs receive content updates when the newly rendered plan differs.
- Commit messages carry honest trailers only when issue/run context is present; never
  fossils from #171.
- Unit tests prove isolation, message shape, and refresh/no-op on deps seams.

**Non-Goals:**

- Changing the day-keyed branch naming scheme or PR title/body format (beyond trailers).
- Changing roadmap scoring, hygiene, milestones, or other GitHub write-backs.
- Making intake / sweep use throwaway worktrees (separate issues if desired).
- Auto-merging the roadmap PR.
- Cross-host locking of the throwaway worktree path (host-local isolation is enough;
  two hosts each opening/updating their own PR head is acceptable; same-day branch
  name remains the remote coordination key).

## Decisions

### Decision 1 — Throwaway linked worktree, not bare clone, not operator switch

**Choice:** For the duration of `openRoadmapPr` write/commit/push, create a **linked
throwaway worktree** of the day-keyed branch (created from `baseBranch` when missing),
perform all file writes and `gitCommit`/`gitPushBranch` with that worktree path as
`cwd`, then remove the worktree (best-effort cleanup on success and failure).

**Why not bare clone:** Heavier; push still needs a working tree for the docs file;
worktree reuses the existing object store and credentials of `repoDir`.

**Why not stay on operator checkout with careful restore:** Even with
`git stash` / restore-branch, a crash or concurrent operator edit mid-run leaves the
user on the wrong branch or with lost state. Isolation removes that class of failure.

**Why not issue-scoped `createWorktree`:** That helper is built for
`pipeline/<issue>-<slug>` managed advance worktrees (capacity, reclaim, markers). Roadmap
writeback is a short-lived docs operation without an issue number. Prefer a narrow
deps seam:

```ts
// conceptual — exact names left to implementer
gitWithThrowawayWorktree(
  repoDir: string,
  branch: string,
  baseRef: string,
  fn: (worktreeDir: string) => Promise<T>,
): Promise<T>
```

or explicit `createThrowawayWorktree` / `removeThrowawayWorktree` on `WritebackDeps`
so unit tests never touch real git. Path suggestion:
`.worktrees/roadmap+<repoSlug>+<date>` (or under `os.tmpdir` if the implementer
prefers zero pollution of managed roots) — document the choice in code comments and
tests; prefer under-repo `.worktrees/` only if removal is guaranteed so capacity
accounting for advance worktrees is unaffected.

**Operator `repoDir`:** Used only as the git common directory source (for
`git worktree add`) and for reading config; **never** as the commit cwd after this
change. Remove `gitSwitchBranch` from the roadmap writeback path (and from the
regression that required it).

### Decision 2 — Existing PR: compare content on branch head, then update or no-op

**Choice:** When `findPrByHead` returns a PR URL:

1. Ensure the day-keyed branch exists remotely/locally as needed inside the throwaway
   worktree.
2. Read `docs/roadmaps/<repo>.md` **from that worktree** (branch head), not from
   whatever is checked out in the operator tree.
3. If content equals the new render → log no-op, return existing PR URL (no commit).
4. If content differs → write, commit, push to the same branch head, return existing
   PR URL (do **not** open a second PR).

When no PR exists, keep create-branch-from-base → write → commit → push → `createPr`
behavior, still entirely inside the throwaway worktree.

**Why not force a new branch per run:** Day-keyed branch + one open PR is the existing
idempotency contract operators already use; this change only unblocks content refresh.

**Content identity:** Byte-for-byte equality of the rendered markdown string (same as
today’s unchanged-docs check), after rendering with `renderRoadmapMd(plan)`.

### Decision 3 — Commit metadata: optional real trailers, never fossils

**Choice:**

- Subject/body stay roughly:  
  `docs: roadmap for <repo> (generated YYYY-MM-DD)`  
  (no Issue/Run lines baked into a constant string).
- If both `issueNumber` and `pipelineRunId` are provided to writeback (optional args /
  deps fields — e.g. when roadmap is invoked under a pipeline run that has them),
  append trailers via `withTrailers` from `traceability.ts`.
- If only one is present, either require both or omit both — **prefer omit both unless
  both are known**, so we never invent a half-fake `Pipeline-Run`.
- When neither is available (normal `pipeline roadmap` CLI path today), commit with
  **no** `Issue:` / `Pipeline-Run:` trailers.

**Why not invent `Issue: #0` or `Pipeline-Run: roadmap/<date>`:** Fossils of a different
shape; grepping real issue runs would be polluted. Honest omission is better for a
no-issue-number command. If a future change threads a synthetic run id for audit, that
can be a separate capability with an explicit non-issue key (out of scope).

**Delete** the literal constants `#171` and `171/2026-06-17T04:37:16Z` from the
writeback source; a unit test greps the commit message argument for those strings and
fails if they reappear.

### Decision 4 — Deps-seam shape for tests

**Choice:** Extend `WritebackDeps` with injectable worktree lifecycle (or a single
higher-order helper) so tests assert:

- `gitSwitchBranch` is never called (or is removed from the interface if unused).
- Commit/push receive a worktree path **distinct from** the `repoDir` argument.
- On existing-PR + different content: `gitCommit` + `gitPushBranch` called once;
  `createPr` not called.
- On existing-PR + same content: neither commit nor createPr.
- Commit message assertions for trailers with/without context.

Keep unit tests free of real network/git (repo convention).

### Decision 5 — Cleanup and failure semantics

**Choice:** Always attempt throwaway worktree removal in a `finally` block after
writeback. Failure to remove is logged but does not override a successful PR URL
return. Failure mid-commit leaves no operator branch switch (the invariant that
matters). Do not use `git worktree remove --force` on arbitrary paths — only on the
path created for this operation (safety scope: managed throwaway root).

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Throwaway worktree left behind on crash | `finally` cleanup; path under a dedicated prefix so `pipeline:cleanup` / doctor can recognize orphans later if needed |
| Day-keyed branch race between two hosts | Existing remote branch is the source of truth; last push wins (acceptable for docs PR); no operator checkout damage |
| Content compare false-negative (line endings) | Use the same `renderRoadmapMd` string for write and compare; write with explicit trailing newline as today |
| Removing `gitSwitchBranch` breaks other writeback callers | Grep: only `openRoadmapPr` uses it for roadmap; update tests that assert the old behavior |
| Optional trailers diverge from “every pipeline commit has trailers” living spec | Explicit ADDED requirement: no-issue-number roadmap commits may omit trailers; never invent fossils — documents the intentional exception |
| Capacity pressure if worktrees under `.worktrees/` | Prefer short-lived path + guaranteed remove; avoid counting against advance capacity max |

## Migration Plan

- Behavior change only; no config keys, no data migration.
- Operators with a dirty main checkout can run `pipeline roadmap --apply` without
  branch disruption after this lands.
- Open day-keyed PRs from before the fix remain valid; the next `--apply` on the same
  day will refresh their content if the plan differs (first useful refresh).
- Rollback: revert the change; worst case is return to operator-checkout switch +
  fossils (known bad).

## Open Questions

None blocking. Implementer may choose throwaway path under `.worktrees/` vs
`os.tmpdir()` as long as isolation + cleanup hold and tests pin the no-operator-switch
invariant.
