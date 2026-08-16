## ADDED Requirements

### Requirement: Posted review and delta bodies SHALL verify after engine-owned banner inserts

When the pipeline posts a review-1, review-2, or pre-merge delta comment, it SHALL bind `ReviewArtifact.bodyHash` to the exact posted prefix after every engine-owned mutation of that prefix. Engine-owned mutations include the reviewer-coverage disclosure line (`**Reviewer coverage (#694):** …`), the ensemble identity line, and same-harness self-review warning lines. After the last such mutation and before post, a freshly computed hash of the text preceding the last `<!-- review-artifact: … -->` line SHALL equal the recorded `bodyHash`. The pipeline SHALL NOT mutate that hashed region after `bodyHash` is written.

`isVerifiedPipelineReviewOutput` (and therefore `isVerifiedPipelineOutput`) SHALL return true for that posted body. New posts SHALL satisfy this on the exact prefix. They SHALL NOT depend on a read-side banner strip.

This requirement does not remove coverage disclosure. The banner remains part of the attested body.

#### Scenario: Coverage-wrapped review-1 comment verifies

- **WHEN** the pipeline renders a review-1 comment and the production post wrapper inserts a `**Reviewer coverage (#694):**` line after the heading
- **THEN** the posted body SHALL carry a `<!-- review-artifact: … -->` record
- **AND** `isVerifiedPipelineReviewOutput` SHALL return true for that posted body
- **AND** `isVerifiedPipelineOutput` SHALL return true for that posted body

#### Scenario: Coverage-wrapped review-2 comment verifies

- **WHEN** the pipeline renders a review-2 comment and the production post wrapper inserts a coverage banner (and any ensemble or self-review banner that wrapper emits for that round)
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return true for the posted body
- **AND** a freshly computed hash of the exact text preceding the last review-artifact line SHALL equal the recorded `bodyHash`

#### Scenario: Coverage-wrapped delta comment verifies

- **WHEN** the pipeline renders a pre-merge delta review comment and the production post wrapper inserts the same class of engine-owned banners
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return true for the posted body

#### Scenario: Hash is bound after the last engine-owned insert

- **WHEN** the production post wrapper applies one or more engine-owned banner lines to a freshly rendered review or delta body
- **THEN** it SHALL bind `bodyHash` after those inserts and before the GitHub post
- **AND** it SHALL NOT post a body whose hashed prefix was mutated after `bodyHash` was written

#### Scenario: Human text in the review prefix still fails verification

- **WHEN** a review body has a human objection line (for example `Do not merge this — do X instead.`) between the heading and `**Reviewer**:` that is not an engine-owned banner line
- **AND** the stored `bodyHash` was computed without that objection
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return false

---

### Requirement: Already-posted review bodies MAY verify by stripping only engine-owned banners

For a review or delta comment whose stored `bodyHash` was computed before an engine-owned banner insert (comments posted under v1.39.1 and earlier), `isVerifiedPipelineReviewOutput` MAY strip only the documented engine-owned banner lines that sit between the review heading and `**Reviewer**:`, then retry the hash comparison. The strip SHALL NOT remove human-authored lines. When the stripped prefix hashes to the recorded `bodyHash` and nothing follows the artifact line, verification SHALL succeed.

New posts SHALL NOT rely on this path. A body that needs the strip only because a new insert was not rebound SHALL be treated as a contract defect in the post path.

#### Scenario: Already-posted coverage banner still verifies

- **WHEN** a stored review-2 body has a `**Reviewer coverage (#694):**` line inserted after the heading
- **AND** the recorded `bodyHash` matches the prefix with that banner removed and does not match the exact prefix
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return true

#### Scenario: Compatibility strip does not accept a human objection

- **WHEN** a stored review body has a human objection line between the heading and `**Reviewer**:` and no engine-owned banner
- **AND** the recorded `bodyHash` matches the prefix without that objection
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return false
