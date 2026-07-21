## Why

The pipeline turns a decision-complete issue into shipped work, but it does nothing to make under-specified issues decision-complete in the first place. Today that's a manual `/pm`-per-issue chore, and `ROADMAP.md` drifts as issues accumulate. Issue #158's `intake` sub-command handles the single-idea front door; this `sweep` sub-command is the complementary **batch** pass: one command that re-specs every thin issue in the backlog and reconciles the entire roadmap in one shot, with a safe preview-by-default / `--apply`-to-commit model.

## What Changes

- Add `sweep` as a new no-issue-number positional sub-command keyword (alongside `intake`, `release`, `init`, `roadmap`, etc.) accepted by the pipeline CLI.
- Add `core/scripts/stages/sweep.ts` implementing the sub-command handler with injectable I/O deps (same seam pattern as `release.ts` and `intake.ts`).
- The handler iterates all open GitHub issues, classifies each as "sufficient" or "thin" via a sufficiency heuristic, and for each thin issue invokes one model harness call to generate an implementable spec body following the WHAT-not-HOW / observable-AC contract (Summary, User story, Acceptance criteria, Out of scope; Open questions only when genuinely ambiguous). Author context is preserved, not replaced.
- After classifying and (optionally) re-speccing issues, the handler re-evaluates `ROADMAP.md` against the current open backlog and proposes a synchronized update across all three ROADMAP structures (release-plan table, per-issue sem-ver table, detail sections). The roadmap update is delivered as a branch + PR for human review — never committed directly to the default branch.
- Without `--apply` the command writes nothing to GitHub: it prints a summary report (which issues it would re-spec and why, plus the roadmap diff it would propose).
- With `--apply` the command performs the writes: issue descriptions are updated in place; the roadmap change is delivered as a branch + PR.
- Re-running sweep is idempotent: an issue that already meets the sufficiency bar is recognized and skipped without an additional model call.
- The sub-command ends with a structured report: per-issue action (`specced` / `left-as-is` / `blocked`) with a one-line reason, plus the roadmap delta and aggregate counts.
- `--repo <owner/repo>` (default: current repo from `gh` config) lets the caller target a different repository.

## Capabilities

### New Capabilities
- `sweep-sub-command`: The `sweep` no-issue-number sub-command: CLI dispatch, sufficiency classification, per-issue spec-generation harness, bulk issue-body update, and roadmap-reconciliation PR proposal.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `sweep` as a recognized keyword that requires no issue number and advances no stage label; it MUST be listed in the help text alongside other no-issue-number modes.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definitions (`--apply`, `--repo`).
- `core/scripts/stages/sweep.ts` — new file (sub-command handler + injectable deps interface).
- `core/scripts/prompts/` — new prompt template for the per-issue spec-generation harness call.
- `core/test/sweep.test.ts` — unit tests for the new stage.
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command.

## Acceptance Criteria

- [ ] `pipeline sweep` is accepted by the CLI without an issue number and without any required flags; the command dispatches the sweep handler.
- [ ] Without `--apply`, the command writes nothing to GitHub and prints a per-issue summary (action + one-line reason) plus the roadmap delta and aggregate counts.
- [ ] With `--apply`, each thin issue's description is updated in place on GitHub; the roadmap update is delivered as a branch + PR targeting the default branch — no direct commit to main.
- [ ] For each open issue, the handler correctly classifies it as sufficient (left-as-is) or thin (re-specced); only thin issues receive a model harness call.
- [ ] Each generated spec follows the WHAT-not-HOW / observable-AC contract: Summary, User story, Acceptance criteria (testable `- [ ]` items), Out of scope; Open questions only when genuinely ambiguous.
- [ ] Author-original context from the existing issue body is preserved in the generated spec — not deleted.
- [ ] Re-running sweep on an already-specced backlog produces no writes and reports all issues as `left-as-is` (idempotent).
- [ ] The roadmap reconciliation proposes a PR that synchronizes the release-plan table, per-issue sem-ver table, and detail sections with the current open backlog.
- [ ] The spec-generation harness is the only model-invoking step; given the generated specs, all issue edits and roadmap mutations are deterministic.
- [ ] All new logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests).
- [ ] `npm run ci` passes end-to-end after the change.
