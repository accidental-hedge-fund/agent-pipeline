## Why

Some repositories adopt agent-pipeline and OpenSpec after years of development. In those repos OpenSpec is absent entirely, freshly initialized, or already **partially** populated by recent pipeline work. The risky case is partial adoption: the mere presence of an `openspec/` workspace implies the repo is spec-covered, even though older accepted behavior was never recorded. Every future pipeline run is then checked only against post-adoption changes, not against the real product contract.

The existing OpenSpec integration (`openspec-integration`) covers the *forward* path — it specs each new change as it is built. Nothing today closes the *backward* coverage gap for behavior that predates adoption. A maintainer who wants future review to be checked against the true contract has no safe, evidence-driven way to find what is missing and codify it without hand-writing dozens of legacy requirements (and without accidentally overwriting the specs that already exist or declaring every accidental implementation detail to be desired product behavior).

This change adds a `backfill` no-issue-number sub-command: a safe maintenance flow that previews which legacy behaviors are already covered, which are missing, which conflict with existing specs, and which are too uncertain to codify without human judgment — and, on explicit opt-in, opens a reviewable spec-only PR that adds coverage for a selected slice of the missing behavior. It never changes application code and never merges.

## What Changes

- Add `backfill` as a new no-issue-number positional sub-command keyword (alongside `intake`, `sweep`, `roadmap`, `release`, `init`, etc.) accepted by the pipeline CLI.
- Add `core/scripts/stages/backfill.ts` implementing the sub-command handler with injectable I/O deps (same seam pattern as `release.ts`, `intake.ts`, `sweep.ts`).
- **Preview by default (non-mutating).** `pipeline backfill` analyzes the repo's accepted behavior against its current living specs and prints a coverage report without writing any spec, issue, branch, or PR. The report explicitly states that nothing was changed.
- **Four-group classification.** The preview reports existing OpenSpec coverage plus candidate legacy behavior in at least four groups: **already-covered**, **missing-coverage**, **conflicting-evidence**, and **uncertain-evidence**.
- **Partial-adoption aware.** Backfill operates on an absent, empty, or partially-populated `openspec/` workspace and never treats a repo as fully covered merely because a workspace exists — it computes coverage from the *content* of living specs, not from their presence.
- **Existing specs are the contract.** Living specs under `openspec/specs/` are treated as the current contract and are never silently overwritten, renamed, or weakened; backfill only proposes *additive* coverage for genuinely missing behavior.
- **Provenance on every candidate.** Each candidate backfill requirement names the user-visible behavior it describes and carries provenance: concrete evidence (tests, docs, code paths, merged history) showing the behavior is accepted, not accidental.
- **Conflicts and weak evidence go to humans.** Candidates with conflicting or insufficient evidence are withheld from living specs and surfaced in the report for human decision rather than codified as guesses.
- **Apply opens a spec-only PR.** `pipeline backfill --apply [--capability <name>]` authors an OpenSpec change containing additive requirement deltas for a selected slice of the missing-coverage candidates, validates it, and opens a reviewable PR targeting the default branch — never committing directly to it, never merging it, and never touching any file outside `openspec/`.
- **Accepted vs. intended is distinguishable.** Each backfilled requirement is annotated (with its provenance) so a reader can tell accepted *existing* behavior apart from new *intended* behavior added by the normal per-change flow.
- **Idempotent.** Re-running backfill after a slice lands recognizes previously-accepted backfill requirements (now in living specs) — and candidates already proposed in an open backfill PR — as covered, rather than duplicating them.
- **Validated before success.** When a slice is applied, backfill validates the resulting workspace (`openspec validate`) before reporting success; a validation failure is surfaced as a blocker with actionable details and no PR is reported as ready.
- `--repo <owner/repo>` (default: current repo) targets a different repository.

## Capabilities

### New Capabilities
- `openspec-coverage-backfill`: The `backfill` no-issue-number sub-command — CLI dispatch, partial-adoption-aware coverage analysis, four-group candidate classification with provenance, non-mutating preview, scale-aware report, and the apply-to-spec-only-PR path with pre-PR validation.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `backfill` as a recognized no-issue-number keyword that advances no stage label and is listed in the help text alongside other no-issue-number modes.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definitions (`--apply`, `--capability`, `--repo`).
- `core/scripts/stages/backfill.ts` — new file (sub-command handler + `BackfillDeps` interface + `realBackfillDeps()`).
- `core/scripts/prompts/` — new prompt template for the behavior-analysis / candidate-drafting harness call.
- `core/scripts/openspec.ts` — read-only helpers reused (`isInitialized`, `isActive`, `listChangeDirs`, living-spec reads, `validate`); a coverage-comparison helper may be added here.
- `core/test/backfill.test.ts` — unit tests for the new stage (injectable deps; no real network/git/subprocess).
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command and operator guidance.

## Acceptance Criteria

- [ ] `pipeline backfill` is accepted by the CLI without an issue number and without any required flags; the command dispatches the backfill handler and advances no pipeline stage label.
- [ ] Preview runs successfully against a repo with no OpenSpec workspace, an empty OpenSpec workspace, and a partially-populated OpenSpec workspace.
- [ ] Without `--apply`, the command writes nothing to GitHub, the filesystem, branches, or PRs, and its output explicitly states that no specs, issues, branches, or PRs were changed.
- [ ] The preview reports existing OpenSpec coverage and candidate legacy behavior in at least four groups: already-covered, missing-coverage, conflicting-evidence, and uncertain-evidence.
- [ ] A partially-populated workspace is not reported as complete merely because an `openspec/` directory exists — coverage is computed from living-spec content and missing behavior is still surfaced.
- [ ] Existing living specs are never overwritten, renamed, or weakened by backfill; the apply path only adds requirements for missing behavior.
- [ ] Every candidate backfill requirement names the user-visible behavior it describes and carries at least one concrete provenance reference (test, doc, code path, or merged history).
- [ ] Candidates classified as conflicting-evidence or uncertain-evidence are excluded from the proposed living-spec additions and listed in the report for human decision.
- [ ] `pipeline backfill --apply` opens a PR targeting the default branch and makes no direct commit to it; the PR's diff touches only files under `openspec/`.
- [ ] Each backfilled requirement is annotated so accepted existing behavior is distinguishable from new intended behavior.
- [ ] Re-running backfill after a slice lands reports the previously-applied behaviors as already-covered and proposes no duplicate requirement for them (idempotent).
- [ ] The report includes aggregate counts, skipped items, conflicts, and a concise "what to review next" summary that is readable at repository scale.
- [ ] When a slice is applied, backfill runs `openspec validate` on the resulting workspace before reporting success; a validation failure is shown as a blocker with actionable details and no PR is reported as ready.
- [ ] The behavior-analysis / candidate-drafting harness call is the only model-invoking step; coverage comparison, file authoring, validation, and PR creation are deterministic given the drafted candidates.
- [ ] Operator documentation explains when to use backfill, how to review provenance, how partial adoption is handled, and why low-confidence behavior is not automatically codified.
- [ ] All new logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests).
- [ ] `npm run ci` passes end-to-end after the change.
