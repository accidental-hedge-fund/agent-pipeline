## Why

Plan-review resume skips OpenSpec `authorArtifact`, so the closed-over `changeId` stays empty. After a `NEEDS_REVISION` verdict, `revalidateArtifact` calls `openspec validateItem` with that empty name. The CLI prints `Nothing to validate`. The pipeline then blocks at plan-review with `OpenSpec change \`\` invalid after revision` and park-releases a clean worktree at remote tip. This blocked #1301 across multiple recoveries on 2026-09-03. Operator recovery patched only the installed v1.40.0 engine. `origin/main` still has the defect.

## What Changes

- On plan-review resume, OpenSpec planning hooks restore the singular in-flight change id from the worktree before any `validateItem` call.
- Restore reuses the existing `openspec.change-singular@1` / `validateOpenspecChangeSingular` discovery. It does not add a second parser.
- Restore prefers the unique change that is not in the pre-worktree baseline. If the worktree has exactly one active change, it uses that.
- If restore cannot choose a singular id, the stage blocks with a named reason. It does not pass `""` to the OpenSpec CLI.
- `openspec.validateItem` refuses an empty or whitespace-only item name without spawning the CLI. That is the class gate for every caller.
- Plan-review resume still skips authoring (#870). Park-release, train, merge-authority, and review-policy stay unchanged.

## Capabilities

### New Capabilities

- `openspec-change-id-restore`: restore the singular OpenSpec change id after a skipped authoring hook, refuse empty `validateItem` names, and block with a named reason when restore cannot choose one id.

### Modified Capabilities

- None. The shared phase runner, skip-authoring contract, singularity contract, and recovery recipes do not change their requirements. This change fills the identity hole those contracts currently leave on resume.

## Impact

- **Class vs site:** the class is closed-over identity written only by a skipped lifecycle hook, then passed empty to an external CLI. The site is OpenSpec `changeId` after `resumePlanReview`. The shared gate is restore-via-existing-singularity plus empty-name refuse in `validateItem`. A path-local mole that only patches `revalidateArtifact` in one call site is incomplete.
- **Reuse first:** `validateOpenspecChangeSingular` (`openspec.change-singular@1`) and `listChangeDirs` already discover the singular change. Resume calls that same function with worktree dirs versus `beforeList`. Do not invent a new discovery layer, hook point, BlockerKind, or recovery recipe.
- **Next identical fault:** any later caller that would pass `""` to `validateItem` fails closed at the wrapper. Implement-stage salvage (sibling issue) can call the same restore. It does not need a new mole for the empty-name class.
- **Code:** `core/scripts/stages/planning.ts` (`makeOpenspecPlanningHooks`), `core/scripts/openspec.ts` (`validateItem`), tests under `core/test/`. Inject `listChangeDirs` / `validateItem`. No live network, git, or subprocess.
- **Out of scope:** re-running the planning harness on resume; park-release rules for a dirty worktree; implement-stage salvage; train, merge-authority, or review-policy behavior.

## Acceptance Criteria

- [ ] Plan-review resume with one active OpenSpec change validates that change after `NEEDS_REVISION`.
- [ ] `openspec.validateItem` is never invoked with an empty or whitespace-only item name.
- [ ] A worktree with no restorable singular change blocks with a named restore reason. The reason does not include `Nothing to validate`.
- [ ] A regression fails if resume plus revision validates `""` or skips restore.
- [ ] Tests inject `listChangeDirs` / `validateItem`. They do no live network, git, or subprocess.
- [ ] Train, merge-authority, and review-policy behavior do not change.
- [ ] After `core/` edits, `node scripts/build.mjs` and `npm run ci` pass.
