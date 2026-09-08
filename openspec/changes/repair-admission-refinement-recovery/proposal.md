## Why

Three reproduced shared-boundary defects prevent ordinary Pipeline work from advancing reliably: repeated Decisions evidence can exceed GitHub's supported issue-body surface, an accepted OpenSpec refinement can validate and then be replaced by the unchanged proposal before implementation, and a forge observation outage can erase a completed child's precise diagnostic while legacy class-budget projection suppresses a later unspent recovery strategy. These are engine contract defects, so the repair must cover the next equivalent grill, OpenSpec, or recovery run rather than only the affected issue paths.

## What Changes

- Represent identical Decisions evidence once in the embedded artifact and reference it from every applicable node and authority request, while preserving semantic round-trip compatibility with previously valid inline artifacts.
- Refuse a Decisions publication before the GitHub mutation when the complete compacted issue body still exceeds the supported ceiling; never truncate unique evidence, discard nodes, or alter unrelated issue content.
- Require a reviewer-accepted OpenSpec refinement to be applied to one coherent authoritative change, structurally revalidated, reread, and used to build the actual implementation input.
- Reject unchanged, unapplied, incoherent, or invalid OpenSpec refinements instead of reporting success and falling back to the previously accepted proposal.
- Parse completed child diagnostics independently from post-child forge refreshes, retain the most precise valid child diagnostic when that refresh fails, and record forge uncertainty without converting an unobservable gate into success.
- At recovery time, use only the recorded linked advance identity and canonical run-store event location to recover a more precise terminal diagnostic when persisted transport evidence is coarse; missing, malformed, or mismatched observations remain fail-closed.
- Make outer recovery eligibility agree with the existing Recovery Episode contract: applicable strategies with remaining per-strategy budget remain eligible even when the legacy class-budget projection is zero, while exhausted and inapplicable strategies remain bounded.
- Preserve exact-candidate, authority, independent-review, independent-sibling, lifecycle-ownership, and no-merge contracts. No new scheduler, controller, recovery framework, or public surface is introduced.

## Acceptance Criteria

- [ ] A deterministic renderer regression with eleven authority nodes sharing the reproduced 25,000-character evidence produces a body within 65,536 characters, parses successfully, and preserves every node, authority field, provenance value, evidence value, content/hash binding, and unrelated issue-body section.
- [ ] A previously valid Decisions artifact with inline evidence parses and re-renders without semantic loss.
- [ ] A body whose genuinely unique Decisions content remains over 65,536 characters is rejected before any issue-body publication attempt, with no truncation or omitted node.
- [ ] A substantive reviewer-accepted OpenSpec refinement changes the validated authoritative artifact, and the exact refined artifact content is present in the implementation input.
- [ ] An unchanged or unapplied refinement, and a refinement that leaves an incoherent or structurally invalid change, is rejected explicitly before implementation; the old proposal is not delivered as if revision succeeded.
- [ ] When a child completes with `tester_rebind_pr_head_unobservable` and the following forge refresh throws, dispatch returns that precise diagnostic plus explicit independent forge-observation uncertainty; it does not report a pass or fabricate Tester binding.
- [ ] A retained same-episode record containing coarse transport evidence, two spent `unlink_engine_scratch` attempts, and a zero legacy class budget can recover the precise diagnostic only from its matching linked advance events and select the unspent applicable `rebind_tester_evidence_after_pr` strategy without changing prior attempts or episode identity.
- [ ] Missing, malformed, non-canonical, or run-mismatched linked events cannot confer a precise diagnostic, successful gate evidence, or Tester binding.
- [ ] An exhausted strategy remains ineligible, diagnostic-specific recipe filtering still excludes inapplicable recipes, and an episode with no applicable unspent strategy enters bounded owned Cooling rather than an unbounded retry or false human hold.
- [ ] An independent sibling remains schedulable while another item is Cooling or waiting.
- [ ] Boundary regressions use injected I/O only and replay the reproduced renderer, refinement-to-implementation, dispatch-diagnostic, and recovery-eligibility failures without real network, git, or subprocess calls.
- [ ] Generated host artifacts are refreshed after implementation changes, `npm run ci` passes, and ordinary independent Pipeline review and GitHub CI complete before any separately authorized merge.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `grill-then-ready-refinement`: Compact repeated Decisions evidence without semantic loss and refuse irreducibly oversized bodies before publication.
- `openspec-integration`: Bind accepted refinements to the coherent validated OpenSpec artifact that supplies implementation input, and reject no-op or invalid application.
- `durable-blocker-classification`: Preserve precise child diagnostics across independent forge observation failures and recover them only through trusted linked-run event identity.
- `recovery-episodes`: Determine eligibility from applicable strategies' remaining per-strategy bounds while preserving episode identity, finite exhaustion, and independent-sibling progress.

## Impact

- Admission rendering and parsing in `core/scripts/grill-decisions.ts` and injected renderer/ready tests.
- OpenSpec revision acknowledgement, artifact validation/reread, and implementation-plan construction in `core/scripts/stages/planning.ts` and planning tests.
- Nested dispatch diagnostic transport in `core/scripts/pipeline.ts`, linked advance-event observation in `core/scripts/loop/supervisor.ts`, recovery applicability/eligibility in `core/scripts/loop/recovery.ts`, and their injected-I/O tests.
- Generated host SKILL artifacts produced by `scripts/build.mjs`; no configuration, schema-version, external API, release, or merge-authority change.
