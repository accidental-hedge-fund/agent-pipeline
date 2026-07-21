## Why

The human-input gate (`findUnacknowledgedComments`) blocks a stage boundary when unacknowledged human comments follow the plan anchor. #390 made the pipeline's own **review verdicts** exempt from the objection-language scan by binding them to a verifiable `bodyHash` artifact (`isVerifiedPipelineReviewOutput`). Every *other* comment the engine posts was left outside that contract.

Issue #471 is the first observed recurrence: the `## Pipeline: Review <N> advanced under severity policy` comment (posted when findings exist but none meet the blocking threshold) carries no verification artifact, and its own wording — "Findings were produced but none meet the repo's `review_policy.block_threshold` … so this item advances **instead** of routing to a fix round" — trips `NEGATION_PATTERNS` (`/\binstead\b/i`). Observed on run `429-2026-07-21T10-37-33-093Z`: review 1 advanced under policy at 11:12:12Z, and review-2 routing then blocked with "1 unacknowledged human comment(s)" naming the engine's own comment. Every run whose review round advances under the severity policy self-blocks one stage later and needs a manual acknowledgement — a factory-stopping papercut.

The root-cause class is structural, not textual: a new pipeline comment type can be added without joining the verification contract, and nothing fails. Widening `NEGATION_PATTERNS` or trusting unverified pipeline-*styled* bodies would re-open the forgery hole #390 closed. The fix is to generalize the verification contract to **all** pipeline-posted comments and make membership drift-guarded.

## What Changes

- **Generalize the verified-output contract.** Introduce a single attestation marker that any pipeline-posted comment can carry — a footer line binding the exact rendered body via SHA-256 (`bodyHash`), the same forgery-resistant mechanism the review artifact already uses. A verifier accepts a body as *verified pipeline output* when it carries either the existing `review-artifact` (with matching `bodyHash`) or the new generic attestation.
- **Single-source the pipeline comment-type registry.** Enumerate every comment type the engine posts in one exported list, and route every pipeline comment post through the attesting helper so the marker cannot be forgotten per-call-site.
- **Attest the severity-policy transition comment** (`## Pipeline: Review <N> advanced under severity policy`) and every other currently-posted pipeline comment type, after an audit of all of them.
- **Widen the gate exemption from "verified review output" to "verified pipeline output".** A trusted-actor comment that verifies is exempt from the `NEGATION_PATTERNS` objection scan; nothing else changes. `NEGATION_PATTERNS` is **not** loosened, and an unverified pipeline-*styled* body still gates exactly as today.
- **Drift-guard tests.** A test enumerates the registry, renders each comment type, and asserts each one verifies and classifies as self-excluded under `findUnacknowledgedComments`; a companion test fails when a `## Pipeline:`-family heading exists in `core/scripts/` that is absent from the registry, so a newly added comment type that skips the contract fails CI.
- **No legacy bypass.** Consistent with #390: a historical, unattested pipeline comment with objection wording gates **once**, and a plain trusted-actor acknowledgement clears it permanently via the existing anchor mechanism. There is deliberately no unverified trust path.

## Capabilities

### Modified Capabilities
- `issue-context-snapshot`: adds a requirement that every pipeline-posted comment carries a verifiable output attestation drawn from a single-sourced registry; modifies the unacknowledged-human-input requirement so the objection-scan exemption keys on *verified pipeline output* (any attested comment type) rather than only verified review verdicts.

## Acceptance criteria

- [ ] A `## Pipeline: Review 1 advanced under severity policy` comment posted by the pipeline actor after the plan anchor produces **zero** unacknowledged comments from `findUnacknowledgedComments`, and review-2 routing does not post `## Pipeline: New human input detected`.
- [ ] Every comment type the engine posts is listed in exactly one exported registry, and each rendered body verifies as pipeline output (`review-artifact` with matching `bodyHash`, or the new attestation marker).
- [ ] A drift-guard test enumerates that registry and asserts each type is self-excluded by `findUnacknowledgedComments` for a trusted author; adding a new pipeline comment type without joining the contract fails the test.
- [ ] A drift-guard test fails when a pipeline comment heading literal exists in `core/scripts/` that is not present in the registry.
- [ ] A regression test replays the observed #429 history (plan anchor → `## Pipeline: Review 1 advanced under severity policy` from the pipeline actor) and asserts no unacknowledged findings; the test fails without the fix.
- [ ] `NEGATION_PATTERNS` is unchanged (drift-guarded or asserted), and an attested body with human text appended after the attestation line fails verification and is still counted as human input.
- [ ] A pipeline-styled, attested body from a **non-trusted** author is still counted as unacknowledged human input.
- [ ] A pipeline comment whose attestation `bodyHash` does not match its rendered body (tampered) fails verification and is still subject to the objection scan.
- [ ] `npm run ci` passes from the repo root, including the regenerated `plugin/` mirror.

## Impact

- `core/scripts/stages/review-parsing.ts` — add the generic attestation encode/verify helpers alongside `hashReviewBody` / `isVerifiedPipelineReviewOutput`; export a combined `isVerifiedPipelineOutput`.
- `core/scripts/gh.ts` — the pipeline comment-type registry and the attesting post helper; `classifyComment` recognizes the new marker as a structural pipeline marker.
- Comment builders that must attest: `core/scripts/stages/review-rendering.ts` (`advisoryAdvanceComment`, review-ceiling punch-list), `core/scripts/gh.ts` (stage transition, blocked), `core/scripts/stages/review-routing.ts` (new-human-input warning), `core/scripts/stages/deploy_ready.ts` (`## Pipeline Complete`), `core/scripts/stages/auto_recover.ts`, `core/scripts/pipeline-run.ts` (audit repair, auto-loop continuation/exhausted), `core/scripts/evidence-bundle.ts`, plus the pre-planning context comment — final list set by the audit task.
- `core/scripts/issue-context-snapshot.ts` — `findUnacknowledgedComments` swaps `isVerifiedPipelineReviewOutput` for `isVerifiedPipelineOutput`.
- `core/test/issue-context-snapshot.test.ts` (+ review-parsing / gh tests) — registry drift guard, per-type self-exclusion matrix, the #429 regression, tamper and forgery cases.
- No state-machine edges, review schema, `review_policy` semantics, or config keys change. `plugin/` mirror regenerated via `node scripts/build.mjs`.
