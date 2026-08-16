## ADDED Requirements

### Requirement: Verified review comments with engine-owned banners SHALL NOT trip the human-ack gate

The unacknowledged-human-input gate SHALL treat a trusted-actor review-1, review-2, or pre-merge delta comment as pipeline self-output when `isVerifiedPipelineOutput` is true for the posted body, including when that body carries engine-owned coverage / ensemble / self-review banners. Objection-pattern wording in the verified body (`instead`, `do not`, and the rest of `NEGATION_PATTERNS`) SHALL NOT cause `findUnacknowledgedComments` to return that comment.

The gate SHALL NOT gain a heading-only or banner-string exemption. An unverified review-shaped body from a trusted actor that matches `NEGATION_PATTERNS` SHALL still be counted. A free-form human comment after the revised-plan anchor SHALL still be counted.

This requirement does not loosen `NEGATION_PATTERNS` and does not change author-trust rules.

#### Scenario: Bannered review-2 with instead does not count as unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor review-2 body
- **AND** that body includes a `**Reviewer coverage (#694):**` banner and finding text matching `\binstead\b`
- **AND** `isVerifiedPipelineOutput` is true for that body
- **THEN** `findUnacknowledgedComments` SHALL return zero unacknowledged comments
- **AND** the pipeline SHALL NOT set `blocked` / `needs-human` solely because of that review comment

#### Scenario: Bannered review-1 with objection wording does not count as unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor review-1 body that verifies after engine-owned banners
- **AND** the body contains wording matching `NEGATION_PATTERNS`
- **THEN** `findUnacknowledgedComments` SHALL NOT return that comment

#### Scenario: Bannered delta review with objection wording does not count as unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor pre-merge delta review body that verifies after engine-owned banners
- **AND** the body contains wording matching `NEGATION_PATTERNS`
- **THEN** `findUnacknowledgedComments` SHALL NOT return that comment

#### Scenario: Real human comment after the revised plan still counts

- **WHEN** a free-form human comment with no pipeline verification artifact is posted after the revised-plan anchor
- **THEN** `findUnacknowledgedComments` SHALL return that comment
- **AND** the pipeline SHALL block the stage boundary until re-plan or a trusted acknowledgement / override path clears it

#### Scenario: Unverified review-shaped body with objection wording still counts

- **WHEN** a trusted-actor comment after the plan uses a review heading and contains `NEGATION_PATTERNS` wording
- **AND** `isVerifiedPipelineOutput` is false for that body
- **THEN** `findUnacknowledgedComments` SHALL count the comment as unacknowledged human input
