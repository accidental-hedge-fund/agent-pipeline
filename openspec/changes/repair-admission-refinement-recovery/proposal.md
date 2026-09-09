## Why

Issue #1568 records three reproduced shared-boundary defects that prevent ordinary Pipeline work from advancing reliably: repeated Decisions evidence can exceed GitHub's supported issue-body surface, an accepted OpenSpec refinement can validate and then be replaced by the unchanged proposal before implementation, and a forge observation outage can erase a completed child's precise diagnostic while legacy class-budget projection suppresses a later unspent recovery strategy. These are engine contract defects, so the repair must cover the next equivalent grill, OpenSpec, or recovery run rather than only the affected issue paths.

## What Changes

- Represent identical Decisions evidence once in the embedded artifact and reference it from every applicable node and authority request, while preserving semantic round-trip compatibility with previously valid inline artifacts.
- Refuse a Decisions publication before any mutation when the complete compacted issue body still exceeds the supported ceiling. Enforce that guard at non-dry-run `grillOneIssue`, MAC-valid `runRefineSpecApply`, and `materializeGrillAnswer` so issue-body writes, labels, handoffs, frontiers, sibling rebinds, and recovery receipts remain untouched on refusal; never truncate unique evidence, discard nodes, or alter unrelated issue content.
- Require a reviewer-accepted OpenSpec refinement to be applied to one coherent authoritative change, structurally revalidated, reread, and used to build the actual implementation input.
- Tell the OpenSpec revision producer to edit the identified proposal, tasks, and relevant spec deltas, while preserving stdout-only revision behavior for freeform planning and allowing an approved OpenSpec artifact to remain unchanged.
- Recompute advisory human-comment context on every planning invocation and carry eligible feedback from the prior plan into review, revision, and acknowledgement even after the replacement plan is posted; keep snapshot publication idempotent and pipeline comments excluded.
- Reject unchanged or unapplied OpenSpec refinements when review or eligible human feedback requires substantive change, and reject incoherent or invalid refinements, instead of reporting success and falling back to the previously accepted proposal.
- Parse completed child diagnostics independently from post-child forge refreshes, retain the most precise valid child diagnostic when that refresh fails, and record forge uncertainty without converting an unobservable gate into success.
- At recovery time, use only the recorded linked advance identity and the exact event location derived from Pipeline's configured persistent/common run-store root to recover a more precise terminal diagnostic when persisted transport evidence is coarse; suffix-shaped paths under foreign or operator-worktree roots and missing, malformed, or mismatched observations remain fail-closed.
- Allow the captured #1558 terminal diagnostic, which omits historical `pr_head`, to bind through matching run/item identity plus the current observed full head and candidate epoch. Any explicit head, run, item, root, or candidate mismatch fails closed, and classification never creates a Tester pass or binding.
- Make every pre-action and post-action outer recovery gate agree with the existing Recovery Episode contract: after a failed action, recompute diagnostic-aware applicability and remaining per-strategy budget against the same authoritative episode/progress identity, so a later unspent strategy remains reachable even when the legacy class-budget projection is zero, while exhausted and inapplicable strategies remain bounded.
- Preserve exact-candidate, authority, independent-review, independent-sibling, lifecycle-ownership, and no-merge contracts. No new scheduler, controller, recovery framework, or public surface is introduced.

## Acceptance Criteria

- [ ] A deterministic renderer regression with eleven authority nodes sharing the reproduced 25,000-character evidence produces a body within 65,536 characters, parses successfully, and preserves every node, authority field, provenance value, evidence value, content/hash binding, and unrelated issue-body section.
- [ ] A previously valid Decisions artifact with inline evidence parses and re-renders without semantic loss.
- [ ] A complete body whose genuinely unique Decisions content remains over 65,536 characters is rejected at non-dry-run `grillOneIssue`, MAC-valid `runRefineSpecApply`, and oversized-result `materializeGrillAnswer`; injected spies observe zero issue-body, label, handoff, frontier, sibling-rebind, and recovery-receipt mutations, with no truncation or omitted node.
- [ ] A substantive reviewer-accepted OpenSpec refinement changes the validated authoritative artifact, and the exact refined artifact content is present in the implementation input.
- [ ] The OpenSpec revision producer is explicitly instructed to edit the identified change files, freeform revision remains stdout-only, and an approved unchanged OpenSpec bundle remains valid.
- [ ] A bundle replaced during structural validation is rejected before publication or implementation, and the same stable validated proposal/tasks/spec bundle supplies both handoffs.
- [ ] On replan, eligible human feedback posted after an existing context snapshot reaches the author, reviewer, revision producer, and acknowledgement gate without posting a duplicate snapshot or elevating pipeline-generated comments.
- [ ] An unchanged or unapplied refinement, and a refinement that leaves an incoherent or structurally invalid change, is rejected explicitly before implementation; the old proposal is not delivered as if revision succeeded.
- [ ] When a child completes with `tester_rebind_pr_head_unobservable` and the following forge refresh throws, dispatch returns that precise diagnostic plus explicit independent forge-observation uncertainty; it does not report a pass or fabricate Tester binding.
- [ ] The actual #1558-shaped retained record, including omitted historical `pr_head`, can refine coarse evidence only from its matching linked advance under the configured persistent/common run-store root and select `rebind_tester_evidence_after_pr` by matching run/item identity plus the current full head and candidate epoch, without changing attempts or episode identity or creating Tester success.
- [ ] Missing, malformed, non-terminal, foreign-prefix, operator-worktree-root, run-mismatched, item-mismatched, candidate-mismatched, or explicitly head-mismatched linked events cannot confer a precise diagnostic, successful gate evidence, or Tester binding.
- [ ] The immutable #1568 `driveSupervisor` replay starts with two scratch and two checkpoint attempts spent and a zero legacy class projection; after one failed recovery action it retains the same episode/progress identity and continues to a later applicable unspent strategy without `strategy_cursor_exhausted`, refunding attempts, or suppressing an independent sibling.
- [ ] An exhausted strategy remains ineligible, diagnostic-specific recipe filtering still excludes inapplicable recipes, and an episode with no applicable unspent strategy enters bounded owned Cooling rather than an unbounded retry or false human hold.
- [ ] An independent sibling remains schedulable while another item is Cooling or waiting.
- [ ] Boundary regressions use injected I/O only and replay the reproduced renderer, refinement-to-implementation, dispatch-diagnostic, and recovery-eligibility failures without real network, git, or subprocess calls.
- [ ] Generated host artifacts are refreshed after implementation changes, `npm run ci` passes, and ordinary independent Pipeline review and GitHub CI complete before any separately authorized merge.

## Approach

- Extend the admission guard at the exported writer boundaries. `core/scripts/grill-decisions.ts` establishes `embedDecisionsInBody` as the complete-body renderer and ceiling check; `core/scripts/stages/grill.ts`, `core/scripts/grill-issue.ts`, and `core/scripts/grill-handoff.ts` must call that contract before their first mutation and expose injected spies for every prohibited write.
- Bind linked evidence to the same run-store identity used at dispatch. `core/scripts/pipeline.ts` establishes the pattern by calling `resolveRunStoreRepoDir` and then deriving the child path with `runDirPath(runStoreRepoDir, runId)` before spawn; RecoverySupervisor will accept only the equivalent `events.jsonl` path derived from the configured persistent/common root and retained run ID.
- Reuse Recovery Episode authority rather than adding another budget. `core/scripts/loop/recovery.ts` establishes in `startRecoveryAttempt` that claims are charged by per-strategy bound while the class budget is compatibility-only; `core/scripts/loop/supervisor.ts` will use that same diagnostic-aware episode/progress identity both before an action and after a failed action.
- Keep the already completed OpenSpec planning repair intact. Verify its stable-bundle, current-human-feedback, and freeform compatibility regressions while making no worktree-recovery redesign.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `grill-then-ready-refinement`: Compact repeated Decisions evidence without semantic loss and refuse irreducibly oversized bodies before publication.
- `openspec-integration`: Bind accepted refinements to the coherent validated OpenSpec artifact that supplies implementation input, and reject no-op or invalid application.
- `durable-blocker-classification`: Preserve precise child diagnostics across independent forge observation failures and recover them only through trusted linked-run event identity.
- `recovery-episodes`: Determine eligibility from applicable strategies' remaining per-strategy bounds while preserving episode identity, finite exhaustion, and independent-sibling progress.

## Impact

- Admission rendering and parsing in `core/scripts/grill-decisions.ts`, mutation ordering in `core/scripts/stages/grill.ts`, `core/scripts/grill-issue.ts`, and `core/scripts/grill-handoff.ts`, and injected renderer/writer tests.
- OpenSpec revision instructions, current feedback handoff, artifact validation/reread, and implementation-plan construction in `core/scripts/stages/planning.ts`, `core/scripts/prompts/plan_revision.md`, and planning tests.
- Nested dispatch diagnostic transport in `core/scripts/pipeline.ts`, linked advance-event observation in `core/scripts/loop/supervisor.ts`, recovery applicability/eligibility in `core/scripts/loop/recovery.ts`, and their injected-I/O tests.
- Generated host SKILL artifacts produced by `scripts/build.mjs`; no configuration, schema-version, external API, release, or merge-authority change.
