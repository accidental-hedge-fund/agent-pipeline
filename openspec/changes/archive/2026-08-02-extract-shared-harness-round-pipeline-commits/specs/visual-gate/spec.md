## MODIFIED Requirements

### Requirement: The artifact-publish commit SHALL be pipeline-internal

The stage SHALL author the publish commit with a prescribed subject that `isPipelineInternalCommit` (from the neutral pipeline-commits module) classifies as pipeline-internal, so the commit does NOT invalidate a recorded pre-merge review verdict and is not mistaken for a visual-fix commit. The publish subject prefix SHALL be single-sourced with the classifier (the visual stage MAY import the prefix from the neutral module or share the same constant definition). The subject SHALL be the publish prefix followed by the issue number and nothing else.

#### Scenario: Publish commit does not invalidate the review-SHA gate

- **WHEN** the visual-gate stage commits artifact publish evidence with the prescribed exact subject for the issue
- **THEN** the pre-merge review-SHA gate SHALL classify it as pipeline-internal
- **AND** SHALL NOT invalidate a prior verdict solely because that publish commit landed

#### Scenario: Publish prefix is single-sourced with the classifier

- **WHEN** the visual-gate stage builds the publish commit subject for issue N
- **THEN** the prefix used in that subject SHALL be the same definition the neutral classifier uses for exact-match recognition
- **AND** a near-miss subject with trailing text SHALL remain non-internal
