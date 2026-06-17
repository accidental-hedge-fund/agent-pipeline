## Context

The pipeline CLI has a well-established pattern for no-issue-number sub-commands: a positional keyword is detected early in the dispatch block (`isReleaseCommand`, `isInitCommand`, etc.), a dedicated `stages/<name>.ts` handler is imported and called, and all external I/O is injectable via a `<Name>Deps` interface (see `ReleaseDeps` in `release.ts`). The `release` sub-command already performs anchor-based `ROADMAP.md` mutations via four exported helper functions (`insertIntroChainRow`, `insertReleasePlanRow`, `insertShippedSection`, `insertPerIssueRow`) — `intake` can reuse three of those (the release-plan row, the per-issue row, and a detail-section insertion) rather than re-implementing ROADMAP parsing.

## Goals / Non-Goals

**Goals:**
- Add `intake` as a fully-exercised no-issue-number sub-command using the existing dispatch and injectable-deps patterns.
- Reuse the ROADMAP anchor-based mutation helpers from `release.ts` for the three roadmap write sites.
- Keep the model-invoking boundary to a single harness call (spec generation only) so the command is auditable and its non-model behavior is unit-testable.
- `--dry-run` is a first-class mode that prints without writing.

**Non-Goals:**
- Replacing or wrapping the standalone `/pm` skill (the prompt contract is equivalent, not a dependency).
- Auto-merging the roadmap PR or moving the issue into a release (a human owns those decisions).
- Running planning/implementation — intake stops at a filed issue + roadmap PR.
- Bulk re-speccing of existing issues.
- Interactive prompting (the command is non-interactive; all inputs are flags).

## Decisions

**Decision: embed the spec-generation prompt in `core/`, not a dependency on the `/pm` skill.**
The pipeline engine has zero external-skill dependencies today; importing a prompt from an installed Claude Code skill would break that property and introduce a version-coupling risk. The WHAT-not-HOW / observable-AC spec contract is a few dozen lines of prompt text, easily embedded in `core/scripts/prompts/intake.md` with `{{placeholders}}` for the description, repo context, and roadmap context.

**Decision: reuse the anchor-based ROADMAP mutation helpers from `release.ts`.**
`release.ts` exports `insertReleasePlanRow`, `insertPerIssueRow`, and anchor-based text-replacement helpers. The intake handler needs three of these four mutations (release-plan row, per-issue row, detail-section bullet). Importing the exported helpers avoids duplicating fragile anchor-scanning logic. The detail-section bullet (a fourth mutation not covered by the release sub-command's `insertShippedSection`) will need a new `insertDetailSectionBullet` helper, following the same anchor pattern.

**Decision: `--release <vX.Y.Z>` required to pin; omit → propose from roadmap context.**
Forcing a required `--release` would be user-hostile for a "quick intake" flow. Inferring silently would produce surprising labels. The middle ground: if omitted, the handler reads the roadmap's release-plan table to find the first open lane (no "shipped" marker) and proposes it in the dry-run output and in the PR description, with a comment in the issue body noting "proposed: vX.Y.Z — correct before merging the roadmap PR." The human retains the correction decision.

**Decision: two-label minimum on the created issue.**
`pipeline:ready` ensures the new issue enters the normal pipeline flow immediately. `release:vX.Y.Z` links it to the roadmap. Both are created by `--init` already; no new label types are needed.

**Decision: injectable deps seam covers all external calls.**
Following the `ReleaseDeps` / `ShaGateDeps` pattern: `IntakeDeps` injects `runHarness` (model call), `createIssue` (gh API), `readFile`/`writeFile`, `gitCreateBranch`, `gitCommit`, `createPR`. Production builds `realIntakeDeps()`. Tests supply fakes. No network or subprocess in unit tests.

## Risks / Trade-offs

- *ROADMAP anchor drift* → If ROADMAP.md anchors are renamed, the mutation helpers will throw with an "anchor not found" error. Mitigation: the same risk exists for `release.ts`; the error message names the missing anchor so a human can fix it. No new risk class introduced.
- *Spec quality depends on description quality* → A one-word description produces a low-quality spec. The dry-run mode lets a caller inspect before committing. No silent quality floor is enforceable; the human reviews the roadmap PR before merge.
- *Proposed release slot may be wrong* → The heuristic (first open lane from the release-plan table) is simple and may pick the wrong lane. The PR description and issue body both surface the proposed slot with a "correct before merging" note.
- *Single harness call may time out or be refused* → The handler propagates the error with a non-zero exit; no partial writes occur because the model call precedes all GitHub writes.
