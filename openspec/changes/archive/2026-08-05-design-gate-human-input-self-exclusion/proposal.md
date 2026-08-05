## Why

The human-input acknowledgement gate (`findUnacknowledgedComments`) repeatedly blocks after a successful design-gate with "N unacknowledged human comment(s) after the latest plan" when the only post-plan comments are pipeline-authored **Design Interrogation** rounds. Those comments use heading `## Design Interrogation` and hidden `<!-- design-gate-state: … -->` markers that were never added to the classification / attestation inventory when #390 / #471 / #484 closed the same false-positive class for other pipeline comment types. Durable recovery clears `blocked` and redispatches, then reblocks on the same evidence, burning recovery budget (dogfood: #784, #762).

## What Changes

- **Classify design-gate comments as pipeline-authored.** Extend the structural markers used by `classifyComment` so design-gate issue comments (heading `## Design Interrogation` and/or a design-gate durable-state sentinel) return `pipeline`, not `human`.
- **Attest design-gate posts.** Route design-gate comment rendering through the same verified-output contract as other engine posts (`pipeline-attest` and/or a terminal decodable design-gate state artifact accepted by `isVerifiedPipelineOutput`), so challenge prose that matches objection patterns cannot false-block review-1 / fix entry.
- **Gate self-exclusion for trusted design-gate artifacts.** After a resolved design-gate, advance into review-1 / fix MUST NOT require a manual operator ack solely because design-interrogation comments exist after the plan. Real operator comments after the plan MUST still block until re-plan or trusted override/ack.
- **Registry + living-spec inventory.** Ensure design-interrogation is enumerated in the pipeline comment-kind registry and that living OpenSpec requirements name this #390-class extension explicitly (classification headers, sentinels, verification, and gate scenarios).
- **Regression coverage.** Unit tests prove: plan → design-gate comments only → zero unacknowledged; genuine human after plan still unacknowledged; forged / non-decodable design-gate shapes still gate; human text after a terminal marker still gates.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `issue-context-snapshot`: Comment classification gains design-gate structural markers; verified-pipeline-output includes design-gate durable-state artifacts; unacknowledged-human-input scenarios cover design-gate self-exclusion without weakening forge resistance.
- `design-interrogation-gate`: Design-gate progress comments posted to the issue MUST carry verified pipeline output markers and MUST self-exclude from the human-input gate when trusted.

## Acceptance criteria

- [ ] `classifyComment` returns `pipeline` for design-gate comment bodies that use the production heading (`## Design Interrogation`) and/or a recognized design-gate durable-state marker (and continues to return `human` for unmarked free-form bodies).
- [ ] Design-gate comment render posts through the verified-output contract (`pipeline-attest` and/or terminal decodable `design-gate-state` accepted by `isVerifiedPipelineOutput`), consistent with #471 / #484.
- [ ] With a trusted pipeline actor, `findUnacknowledgedComments` over plan → design-gate progress comments only returns `[]` (including when challenge prose matches objection / negation patterns).
- [ ] A genuine human comment after the plan still counts as unacknowledged human input.
- [ ] A design-gate-styled body from a non-trusted author, a non-decodable design-gate-shaped body with objection wording, or human text appended after a terminal design-gate / attest marker still counts as unacknowledged.
- [ ] Living requirements document this as a #390-class extension of the human-input gate for design-gate artifacts (classification inventory + verification + gate scenarios).
- [ ] `npm run ci` is green; `plugin/` is regenerated if `core/` changes.

## Impact

- `core/scripts/gh.ts` — classification headers / sentinel inventory and `PIPELINE_COMMENT_KINDS` membership for design-interrogation.
- `core/scripts/stages/design_gate.ts` / `core/scripts/design-gate.ts` — comment render attestation and durable-state verification predicates.
- `core/scripts/stages/review-parsing.ts` — `isVerifiedPipelineOutput` composition with design-gate verification.
- `core/scripts/issue-context-snapshot.ts` — `findUnacknowledgedComments` self-exclusion for trusted verified design-gate output.
- `core/test/` — regression coverage for classification, attestation, and gate behavior (and drift guards if registry membership changes).
- `openspec/specs/issue-context-snapshot` and `openspec/specs/design-interrogation-gate` — requirement text aligned with behavior.
- No design-gate challenge/response product semantics change. No disablement of the human-input gate. No auto-ack of unmarked "looks automated" comments. No autonomous merge path.
- `plugin/` mirror regenerated via `node scripts/build.mjs` when `core/` is touched.
