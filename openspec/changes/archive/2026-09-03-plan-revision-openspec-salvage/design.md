## Context

See `proposal.md` for motivation. OpenSpec authoring already records HEAD, invokes the harness, then calls `salvageIfNoNewCommit(..., "OpenSpec authoring", headBefore, "openspec/")` before change discovery and `verifyHarnessCommits`. Plan revision in `runPlanningPhases` currently does `invokeRevisionOnce` → `plan-revision.ack@1` (shared format-repair) → `revalidateArtifact` → post `## Revised Implementation Plan`. It has no salvage and no `openspec/` commit verification.

`harness-round.ts` states that plan-revision and OpenSpec authoring are non-round stages: they use the shared format-repair helper without becoming commit-producing `runHarnessRound` consumers. `RunPlanningPhasesDeps` already injects `gitInWorktree` and `trySalvageUncommittedWork`. `salvageIfNoNewCommit` already forwards an optional scope and injectable git/salvage functions. `trySalvageUncommittedWork` already returns `{ salvaged: true }`, `{ salvaged: false }` (no attempt), or `{ salvaged: false, failureReason }` (attempted git failed). Callers must persist `failureReason`; they must not infer salvage success from a later clean worktree status.

### Class vs site (engine dogfood)

- **Class:** an OpenSpec-writing planning harness can exit 0, leave `openspec/` dirty, and then block. Park-release of a clean remote-tip worktree can drop that work before implementing salvage runs.
- **Site:** #1301 plan revision after `NEEDS_REVISION` on 2026-09-03, compounded by empty-`changeId` restore (separate, complementary).
- **Shared law:** reuse `salvageIfNoNewCommit` with scope `openspec/` at the shared plan-revision call site, plus existing salvage-failure disclosure on the blocker. Capture comparison HEAD per invoke so a first salvage commit cannot skip retry salvage.
- **Next identical fault:** a later OpenSpec-writing plan-revision invoke (including the format-repair retry) is already covered. A new mole issue is not required for the same dirty-`openspec/` + block/park-release sequence.

## Goals / Non-Goals

**Goals:**

- Wire the existing scoped salvage helper at the plan-revision call site so uncommitted `openspec/` work is committed or explicitly reported before revalidate/block/park-release.
- Salvage immediately after every successful revision process exit, including an initial invoke whose acknowledgement contract later triggers format repair.
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
- Changing OpenSpec authoring’s single-HEAD reuse. This change only recaptures HEAD on the plan-revision path.

## Decisions

### 1. Reuse `salvageIfNoNewCommit` in `runPlanningPhases`, do not invent a layer

**Choice:** after each successful plan-revision harness invoke (initial and format-repair retry), call the existing `salvageIfNoNewCommit` helper with scope `openspec/`, that invoke’s pre-invoke HEAD, and the injected `deps.gitInWorktree` / `deps.trySalvageUncommittedWork` seams.

**Why this is the first holding rung:** the helper, the `openspec/` scope, and the failure-reason return already exist. Authoring is the sibling call site. Tests already cover the helper. The implement stage's `RunPlanningPhasesDeps` salvage seam is already injectable.

**Alternatives rejected:**

- **New hook on `PlanningPhaseHooks` (for example `afterRevision`).** Adds an interface for one call. The runner already owns the revision invoke and the OpenSpec-only `revalidateArtifact` hook lacks `issueNumber` / `pipelineRunId`.
- **Salvage only inside OpenSpec `revalidateArtifact`.** Too late: acknowledgement exhaustion and planning-fact claim blocks happen before revalidate. Those exits can still park with dirty `openspec/` files.
- **Migrate plan-revision to `runHarnessRound`.** The shared-round helper is for commit-producing implement/fix rounds. Plan-revision is explicitly a non-round stage. Migration would widen salvage policy toward implement-stage unscoped salvage, which this issue forbids.

Freeform revision also hits this call. Scoped `openspec/` salvage is a no-op when that tree is clean. That is acceptable class coverage, not path widening.

### 2. Capture comparison HEAD immediately before each revision invoke

**Choice:** read HEAD with the injected `gitInWorktree` seam immediately before the first `invokeRevisionOnce`, then salvage against that HEAD as soon as that process exits 0. If the acknowledgement contract triggers format repair, read HEAD again immediately before the retry invoke, then salvage against that retry HEAD as soon as the retry process exits 0.

Exact sequence:

1. `headBeforeInitial = rev-parse HEAD`
2. `invokeRevisionOnce(revisionPrompt)`
3. If `!success`: existing harness-failure block. No salvage.
4. If `success`: `salvageIfNoNewCommit(..., headBeforeInitial, "openspec/")` immediately.
5. Run `plan-revision.ack@1`. If it passes, go to claims/revalidate.
6. If ack fails and format-repair is allowed: `headBeforeRetry = rev-parse HEAD` (this is after any initial salvage commit), then `invokeRevisionOnce(repairPrompt)`.
7. If retry `!success`: existing invoke-failed block, with any durable salvage failure still named.
8. If retry `success`: `salvageIfNoNewCommit(..., headBeforeRetry, "openspec/")` immediately, then return the retry stdout to the contract helper.
9. Contract-exhausted, claims, revalidate, and human-feedback blocks all run after the salvage attempts that already happened.

**Why this diverges from authoring:** OpenSpec authoring captures `osAuthorHeadBefore` once and reuses it after format-repair (`planning.ts` authoring path). If the first salvage creates a commit, a later `salvageIfNoNewCommit(..., osAuthorHeadBefore)` sees `headAfter !== headBefore` and skips retry leftovers. The original revision plan copied that reuse and conflicted with “salvage after each successful invocation”. Per-invoke HEAD is the minimum fix for that conflict. Do not change authoring in this issue.

**Timeout/crash:** do not salvage on `!revisionResult.success`. Authoring returns immediately on harness failure. Implement-stage crash salvage (#547) is a different class (commit-producing round). If a later dogfood run loses a timed-out revision, the same helper is the follow-up rung — not a new salvage type.

### 3. Persist salvage `failureReason`; disclose it on every later block; do not advance on failed salvage

**Choice:** keep a durable `revisionSalvageFailureReason` for the plan-revision step.

- When `salvageIfNoNewCommit` returns `failureReason`, store it. Do not drop it when a later generic blocker is composed.
- When a later salvage on this step returns `salvaged: true`, clear the stored failure (the retry recovered the work).
- When a later salvage returns `{ salvaged: false }` with no `failureReason` (HEAD advanced or in-scope clean), keep the stored failure. Do not treat a clean porcelain status as salvage success.
- Every later `setBlocked` on this step (ack invoke-failed, ack contract-exhausted, facts claims, revalidate, human-feedback ack) SHALL append the existing `#521` phrasing (`Salvage of uncommitted work also failed: …`) when a failure is stored.
- Always proceed to revalidate after a successful invoke even when salvage failed, so invalid revised files still produce `openspec-invalid` rather than a silent missing-revision park.
- If salvage failed and revalidate plus human-feedback ack otherwise succeed, the plan-review outcome SHALL still block at `plan-review` with existing kind `harness-failure`, naming the salvage failure as the reason. Do not post-and-advance to implementing. Do not invent a new blocker kind.

**Why:** park-release must not be the first observer. A dirty tree after failed salvage is retained by existing park-release dirty-worktree law, but a named blocker is still required so operators do not need `terminal.log`. Revalidate success must not hide a failed salvage and then advance or park-release dirty OpenSpec work.

### 4. Do not add revision-path `verifyHarnessCommits`

**Choice:** skip a new path-constraint guard on revision commits.

**Why:** authoring needs the guard because unscoped salvage used to stage `tasks/todo.md`. Revision salvage is born scoped to `openspec/`. Adding `verifyHarnessCommits` would be extra surface, not the first holding rung.

## Risks / Trade-offs

- **Salvage may commit a half-written OpenSpec revision.** → Revalidate still runs. An invalid change still blocks as `openspec-invalid`. The files survive park-release as a commit (or as dirty files if salvage failed). That is strictly better than dropping the revision.
- **Freeform plan-revision will call scoped salvage.** → No-op when `openspec/` is clean. If a freeform worktree has stray `openspec/` dirt, it may be committed. Acceptable class coverage.
- **Salvage commit may be local-only until a later push.** → Existing park-release retains local-only commits. This change does not force-push (#622).
- **Authoring still reuses one HEAD across format-repair.** → Out of scope. This issue only recaptures HEAD on the plan-revision path, where the dogfood loss happened.

## Migration Plan

No config, label, or data migration. The next plan-revision invoke after this change lands will salvage. Rollback is a revert of the planning call-site wiring. No persisted state depends on it.
