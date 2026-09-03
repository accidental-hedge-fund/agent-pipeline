## Why

Plan-review resume still feeds the reviewer `promptPlanText` from the latest `## Implementation Plan` / `## Revised Implementation Plan` GitHub comment (`extractPlan`). Fresh OpenSpec authoring already passes `proposal.md` and spec deltas from the worktree. On 2026-09-03, #1301 recoveries committed the reviewer's required pins into `openspec/changes/train-events-evidence-integrity/` and re-entered plan-review. Codex still returned `NEEDS_REVISION` for those same pins because resume reviewed the stale posted proposal. Empty-`changeId` restore (#1416) does not fix this: identity can be restored while the prompt still quotes the old comment.

## What Changes

- On OpenSpec plan-review resume, use one resolved-change flow before any review or revision prompt: restore `changeId` when it is empty, then bind `proposal.md` and spec deltas from that resolved id.
- A non-empty `changeId` is the resolved id. Bind files from that id. Do not re-run singularity to pick a different id. If that id has no readable `proposal.md`, block. Do not fall back to the GitHub comment.
- Reuse `restoreChangeIdIfEmpty` plus `readChangeFile` / `readSpecDeltas`. Do not scrape the plan comment as the living plan when a restorable change exists.
- Keep the GitHub plan comment as history for human-feedback extraction. After a successful bind, that comment MUST NOT overwrite `promptPlanText`.
- When restore cannot choose a singular change, or when the resolved id has no readable `proposal.md`, block with tag `openspec-invalid`. Do not invoke the reviewer or reviser with comment text as an OpenSpec proposal.
- Freeform resume (no OpenSpec bind) keeps using the comment.
- `design.md` and `tasks.md` stay living files on the worktree. Do not add new prompt placeholders for them. `readSpecDeltas` still concatenates only `specs/**/*.md`. `planReviewCwd` stays `wt.path`.
- Do not re-invoke the planning authoring harness. Do not delete historical plan comments. Do not change merge-authority or review-schema.

## Capabilities

### New Capabilities

- `openspec-plan-review-resume-artifacts`: bind OpenSpec plan-review resume (and later revision in that session) to the current worktree `proposal.md` and spec deltas instead of the stale GitHub plan comment.

### Modified Capabilities

- None. `openspec-change-id-restore` still restores identity. `openspec-context-propagation` still requires spec deltas on plan-review. This change fills the resume hole those contracts leave when authoring is skipped and the comment is older than the worktree files.

## Impact

- **Class vs site:** the class is using a stale GitHub comment as the sole plan text when a living in-repo OpenSpec change exists. The site is `runPlanningPhases` plan-review resume (`promptPlanText = extractPlan(comments)`). A path-local mole that only patches one comment scrape is incomplete. The shared bind is restore-via-existing-singularity plus the same `readChangeFile(proposal.md)` / `readSpecDeltas` readers first-pass authoring already uses.
- **Shared classifier / recipe / gate / controller:** none. This is prompt-artifact binding, not recovery classification, merge authority, or review policy. Do not add a BlockerKind or `BLOCKER_RECIPES` entry. Reuse tag `openspec-invalid` from #1416 for restore failure and for an unreadable living proposal.
- **Next identical fault:** implementing-resume and any later skipped-authoring OpenSpec path that would otherwise pass comment text as the plan can call the same bind. They do not need a new mole for "stale comment vs living proposal".
- **Reuse first:** `restoreChangeIdIfEmpty`, `openspec.readChangeFile`, `openspec.readSpecDeltas`, existing `promptPlanText` / `specContext` fields, and the #1416 inject bag on `makeOpenspecPlanningHooks`. Do not invent a durable identity store, a comment-id parser, a new prompt placeholder, or a required `PlanningPhaseHooks` method.
- **Code:** `core/scripts/stages/planning.ts` (`runPlanningPhases` resume branch, `makeOpenspecPlanningHooks`), tests under `core/test/`. Inject comment listing plus worktree file reads. No live GitHub, git, or subprocess in unit tests.
- **Out of scope:** deleting historical plan comments; re-running the planning harness on resume; changing Codex/Grok review quality beyond giving them the current artifacts; train, merge-authority, or review-schema behavior; implementing-resume wiring (sibling site; same bind, later caller); inlining `design.md` / `tasks.md` into prompt fields.

## Acceptance Criteria

- [ ] OpenSpec plan-review resume with one restorable change passes the reviewer the current worktree `proposal.md` as plan text and the current spec deltas as spec context.
- [ ] That reviewer prompt does not use the GitHub plan comment as the sole plan text when the worktree `proposal.md` differs from the comment.
- [ ] A worktree whose committed `proposal.md` already contains prior `NEEDS_REVISION` pins is not re-asked for those pins solely because the GitHub comment is older.
- [ ] The later plan-revision prompt in that same resume session also receives the bound worktree `proposal.md` and spec deltas, not only the stale comment.
- [ ] Empty-`changeId` resume restores the singular id, then binds files from that restored id before review or revision prompts.
- [ ] A non-empty resolved `changeId` binds files from that id and does not pick a different change. If `proposal.md` is missing, unreadable, or blank, resume blocks with tag `openspec-invalid` and does not use the GitHub comment as plan text.
- [ ] Missing or blank `proposal.md` after a resolved id blocks at plan-review with tag `openspec-invalid` before `invokeReviewer` or `invokeRevision`. Empty spec deltas still bind as `""`.
- [ ] Zero or multiple restore candidates block at plan-review with the named change-id restore reason before `invokeReviewer` or `invokeRevision`.
- [ ] Freeform plan-review resume still uses the GitHub plan comment as plan text.
- [ ] Plan-review resume still skips `authorArtifact`.
- [ ] `design.md` and `tasks.md` are not added as new prompt fields. The reviewer cwd stays the worktree.
- [ ] A regression fails if resume ignores worktree `proposal.md` when a singular change is present.
- [ ] Tests inject comment bodies plus worktree `proposal.md` / spec-delta reads. They do no live GitHub, git, or subprocess.
- [ ] Train, merge-authority, and review-schema behavior do not change.
- [ ] After `core/` edits, `node scripts/build.mjs` and `npm run ci` pass.
