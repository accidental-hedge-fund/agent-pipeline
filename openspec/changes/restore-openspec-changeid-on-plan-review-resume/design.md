## Context

See `proposal.md` for why.

Current wiring:

- `makeOpenspecPlanningHooks` closes over `let changeId = ""`. Only `authorArtifact` assigns it, via `validateOpenspecChangeSingular` (`openspec.change-singular@1`) on `listChangeDirs(wt)` versus `beforeList`.
- `resumePlanReview` (#870) skips `authorArtifact` and reuses the posted plan comment. `changeId` stays `""`.
- After `NEEDS_REVISION`, `revalidateArtifact` calls `openspec.validateItem(wt.path, changeId)` with that empty name. The CLI prints `Nothing to validate`.
- `validateItem` currently forwards any name to `openspec validate <name> --json`.
- `RunPlanningPhasesDeps` already injects `listChangeDirs`. Fix and pre-merge already inject `openspecValidateItem`. Hook methods `validateArtifact` / `revalidateArtifact` do not take `deps`.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: reuse `validateOpenspecChangeSingular` and `listChangeDirs`. Do not add a second discovery layer.
- Restore identity inside the existing OpenSpec validation hooks before any `validateItem` call.
- Refuse empty names at `validateItem` so the class is gated for every caller.
- Keep tests hermetic with injected `listChangeDirs` / `validateItem`.

**Non-Goals:**

- A new `PlanningPhaseHooks` method, BlockerKind, recovery recipe, or durable change-id store.
- Re-running the planning harness on resume.
- Park-release changes for a dirty worktree.
- Implement-stage salvage (sibling issue). That path MAY call the same restore later.
- Train, merge-authority, or review-policy edits.

## Decisions

### D1 — Restore inside existing OpenSpec validation hooks

When the closed-over `changeId` is empty, `validateArtifact` and `revalidateArtifact` restore it from the worktree, then validate. Do not add a restore hook on the shared runner. The runner stays path-neutral. Freeform hooks have no change id.

Alternative considered: restore in `runPlanningPhases` at `resumePlanReview`. Rejected: the runner would learn OpenSpec identity, and it invents a lifecycle step the hook interface does not declare.

Alternative considered: a new `restoreIdentity` hook. Rejected: unrequested interface. Existing validation hooks already need the id.

### D2 — Selection is `validateOpenspecChangeSingular`

Build `{ fresh, all }` the same way authoring does:

- `all` = `listChangeDirs(worktree)`
- `fresh` = ids in `all` that are not in `beforeList`

Pass that object to `validateOpenspecChangeSingular`. That function already prefers the unique fresh id, then falls back to `all.length === 1`. Multi-fresh and zero-id cases already return a named reason.

Do not scrape `_OpenSpec change \`id\`` from the plan comment. A sibling issue covers stale plan comments. The worktree change directory is the same source of truth authoring uses.

Do not persist `changeId` in run-state JSON. That is a new store.

### D3 — Empty-name refuse lives in `validateItem`

If `name` is empty or whitespace-only, return `{ valid: false, unavailable: false, issues: [{ message: ... }] }` without calling `runOpenspec`. Every current and future caller hits the same gate. Plan-review resume is the site. The wrapper is the class.

Alternative considered: guard only in `revalidateArtifact`. Rejected: path-local mole. The next empty-name caller would need another issue.

Do not throw. Callers already handle an invalid `ValidateResult`.

### D4 — Inject listing and validation at hook construction

`validateArtifact` / `revalidateArtifact` do not receive `deps`. Do not change `PlanningPhaseHooks` signatures.

Give `makeOpenspecPlanningHooks` an optional inject bag for `listChangeDirs` and `validateItem`, defaulting to `openspec.listChangeDirs` and `openspec.validateItem`. Tests pass fakes. Production stays on the module functions.

`RunPlanningPhasesDeps.listChangeDirs` remains the implement-deliverable seam. Do not merge those seams in this change.

Empty-name tests call `validateItem("")` directly. The early return means those tests need no binary and no inject.

### D5 — Restore failure keeps the existing OpenSpec block tag

On restore failure, return the same `{ ok: false, tag: "openspec-invalid" }` shape `revalidateArtifact` already uses. Put a named reason first: change-id restore failed, plus the singularity diagnostic. Do not add a BlockerKind. Do not add a `BLOCKER_RECIPES` entry. Do not grant human authority for a missing identity.

The shared runner already `setBlocked`s at plan-review with the hook reason.

### D6 — Class coverage, not implement-stage salvage

Restore-on-empty in both validation hooks is the class fix for skipped-author identity. Implement resume that never reaches those hooks is the sibling salvage issue. Empty-name refuse still protects that later caller if it calls `validateItem("")`.

## Risks / Trade-offs

- **[Risk]** `beforeList` comes from `cfg.repo_dir`, not the worktree. If those trees already share the same single change, restore still succeeds via the exactly-one fallback. If they share several changes and none is unique, restore blocks by design.
  → Mitigation: keep the singularity contract. Do not pick an arbitrary id.

- **[Risk]** A worktree at remote tip may already contain the authored change as a commit, while park-release can still drop uncommitted revision. This change restores the id so validation can run. It does not salvage dirty revision files.
  → Mitigation: leave park-release and implement salvage to their issues.

- **[Risk]** Inject-at-construction can drift from `RunPlanningPhasesDeps.listChangeDirs`.
  → Mitigation: accepted for this cut. Unifying the seams is extra scope.

## Migration Plan

No schema, label, or CLI migration. Ship in the engine. Existing plan-review resume of OpenSpec issues starts restoring on the next run.

Rollback: revert the planning-hook restore and the `validateItem` empty-name return. No durable state to unwind.
