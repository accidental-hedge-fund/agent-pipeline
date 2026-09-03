## Context

See `proposal.md` for motivation. OpenSpec authoring already records HEAD, invokes the harness, then calls `salvageIfNoNewCommit(..., "OpenSpec authoring", headBefore, "openspec/")` before change discovery and `verifyHarnessCommits`. Plan revision in `runPlanningPhases` currently does `invokeRevisionOnce` → `plan-revision.ack@1` (shared format-repair) → `revalidateArtifact` → post `## Revised Implementation Plan`. It has no salvage and no `openspec/` commit verification.

`harness-round.ts` states that plan-revision and OpenSpec authoring are non-round stages: they use the shared format-repair helper without becoming commit-producing `runHarnessRound` consumers. `RunPlanningPhasesDeps` already injects `gitInWorktree` and `trySalvageUncommittedWork`. `salvageIfNoNewCommit` already forwards an optional scope and injectable git/salvage functions.

### Class vs site (engine dogfood)

- **Class:** an OpenSpec-writing planning harness can exit 0, leave `openspec/` dirty, and then block. Park-release of a clean remote-tip worktree can drop that work before implementing salvage runs.
- **Site:** #1301 plan revision after `NEEDS_REVISION` on 2026-09-03, compounded by empty-`changeId` restore (separate, complementary).
- **Shared law:** reuse `salvageIfNoNewCommit` with scope `openspec/` at the shared plan-revision call site, plus existing salvage-failure disclosure on the blocker.
- **Next identical fault:** a later OpenSpec-writing plan-revision invoke (including the format-repair retry) is already covered. A new mole issue is not required for the same dirty-`openspec/` + block/park-release sequence.

## Goals / Non-Goals

**Goals:**

- Wire the existing scoped salvage helper at the plan-revision call site so uncommitted `openspec/` work is committed or explicitly reported before revalidate/block/park-release.
- Keep salvage testable through the existing planning git/salvage seams.

**Non-Goals:**

- A new salvage engine, staging rule, or ownership-checkpoint path for plan revision.
- Migrating plan-revision onto `runHarnessRound` solely to obtain salvage.
- Salvaging implement-stage product code from plan-review (unscoped salvage).
- Salvaging on plan-revision timeout/crash (`!success`). That matches authoring, which also salvages only after a successful invoke.
- Adding `verifyHarnessCommits` on the revision path. Scoped salvage already restricts the commit to `openspec/`.
- Changing park-release of a truly clean remote-tip worktree.
- Force-pushing unpublished local-only commits during train reclaim (#622).
- Merge-authority or review-policy changes.

## Decisions

### 1. Reuse `salvageIfNoNewCommit` in `runPlanningPhases`, do not invent a layer

**Choice:** after each successful plan-revision harness invoke (initial and format-repair retry), call the existing `salvageIfNoNewCommit` helper with scope `openspec/`, the HEAD captured before the first revision invoke, and the injected `deps.gitInWorktree` / `deps.trySalvageUncommittedWork` seams.

**Why this is the first holding rung:** the helper, the `openspec/` scope, and the failure-reason return already exist. Authoring is the sibling call site. Tests already cover the helper. The implement-stage `RunPlanningPhasesDeps` salvage seam is already injectable.

**Alternatives rejected:**

- **New hook on `PlanningPhaseHooks` (for example `afterRevision`).** Adds an interface for one call. The runner already owns the revision invoke and the OpenSpec-only `revalidateArtifact` hook lacks `issueNumber` / `pipelineRunId`.
- **Salvage only inside OpenSpec `revalidateArtifact`.** Too late: acknowledgement exhaustion and planning-fact claim blocks happen before revalidate. Those exits can still park with dirty `openspec/` files.
- **Migrate plan-revision to `runHarnessRound`.** The shared-round helper is for commit-producing implement/fix rounds. Plan-revision is explicitly a non-round stage. Migration would widen salvage policy toward implement-stage unscoped salvage, which this issue forbids.

Freeform revision also hits this call. Scoped `openspec/` salvage is a no-op when that tree is clean. That is acceptable class coverage, not path widening.

### 2. Capture HEAD once before the first revision invoke (authoring parity)

**Choice:** read HEAD immediately before the first `invokeRevisionOnce`. Pass that same `headBefore` to `salvageIfNoNewCommit` after the initial success and after a successful format-repair retry.

**Why:** this is what OpenSpec authoring does (`osAuthorHeadBefore` reused after format-repair). If the first salvage creates a commit, the second call sees `headAfter !== headBefore` and is a no-op. The #1301 failure was zero commits, not a post-salvage leftover.

**Alternative rejected:** recapture HEAD after the first salvage so format-repair leftovers after a successful first salvage are also committed. That is a new checkpoint policy. Ownership-checkpoint already exists for implement rounds. Do not invent it here.

**Timeout/crash:** do not salvage on `!revisionResult.success`. Authoring returns immediately on harness failure. Implement-stage crash salvage (#547) is a different class (commit-producing round). If a later dogfood run loses a timed-out revision, the same helper is the follow-up rung — not a new salvage type.

### 3. Disclose salvage failure on the plan-review blocker; do not skip revalidate

**Choice:** keep the salvage result (`failureReason`) and, when the step later blocks (ack exhausted, facts claims, revalidate, human-feedback ack), append the existing `#521` phrasing used by authoring (`Salvage of uncommitted work also failed: …`) when a salvage attempt failed. Always proceed to revalidate after a successful invoke even when salvage failed, so invalid revised files still produce `openspec-invalid` rather than a silent missing-revision park.

**Why:** park-release must not be the first observer. A dirty tree after failed salvage is retained by existing park-release dirty-worktree law. A named blocker is still required so operators do not need `terminal.log`.

### 4. Do not add revision-path `verifyHarnessCommits`

**Choice:** skip a new path-constraint guard on revision commits.

**Why:** authoring needs the guard because unscoped salvage used to stage `tasks/todo.md`. Revision salvage is born scoped to `openspec/`. Adding `verifyHarnessCommits` would be extra surface, not the first holding rung.

## Risks / Trade-offs

- **Salvage may commit a half-written OpenSpec revision.** → Revalidate still runs. An invalid change still blocks as `openspec-invalid`. The files survive park-release as a commit (or as dirty files if salvage failed). That is strictly better than dropping the revision.
- **Freeform plan-revision will call scoped salvage.** → No-op when `openspec/` is clean. If a freeform worktree has stray `openspec/` dirt, it may be committed. Acceptable class coverage.
- **Salvage commit may be local-only until a later push.** → Existing park-release retains local-only commits. This change does not force-push (#622).
- **Format-repair leftovers after a successful first salvage are not salvaged.** → Authoring parity. Out of scope unless a later dogfood run shows that sequence.

## Migration Plan

No config, label, or data migration. The next plan-revision invoke after this change lands will salvage. Rollback is a revert of the planning call-site wiring. No persisted state depends on it.
