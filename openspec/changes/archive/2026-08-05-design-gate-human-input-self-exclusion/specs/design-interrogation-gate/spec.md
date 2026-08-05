## ADDED Requirements

### Requirement: Design-gate progress comments SHALL be verified pipeline output and self-exclude from the human-input gate

When the design-gate stage posts progress, resolution, or punch-list content as an issue comment, that comment SHALL be engine-owned verified pipeline output:

1. The body SHALL start with the design-gate heading `## Design Interrogation`.
2. The body SHALL embed the durable stage state as a hidden `<!-- design-gate-state: … -->` artifact suitable for crash/resume rehydration.
3. Newly rendered posts SHALL be registered as comment kind `design-interrogation` and SHALL end with a terminal generic `<!-- pipeline-attest: … -->` marker produced by the shared attesting helper (kind `design-interrogation`), with the durable-state line preceding the attestation so attestation remains last-occurrence / terminal.
4. Challenge prose, note text, and outcome language MAY contain wording that matches human-input objection patterns; such wording SHALL NOT cause the human-input gate to treat a trusted, verified design-gate comment as unacknowledged human input.

This requirement is a #390 / #471 / #484-class extension for design-gate (#436 / #872). It does not change challenge/response product semantics, does not disable the human-input gate for free-form operator comments, and does not grant trust to non-trusted authors or non-verifying forgeries.

#### Scenario: Successful design-gate posts do not require a manual human-input ack before review-1
- **WHEN** design-gate completes with a resolving outcome and posts one or more trusted `## Design Interrogation` progress comments after the plan anchor
- **AND** those comments verify as pipeline output
- **THEN** the advance into `review-1` SHALL NOT post `## Pipeline: New human input detected` solely because of those design-gate comments
- **AND** `findUnacknowledgedComments` SHALL return zero unacknowledged comments for that plan → design-gate-only history

#### Scenario: Design-gate renderer places durable state before terminal attestation
- **WHEN** the design-gate stage builds a progress comment body for posting
- **THEN** the body SHALL start with `## Design Interrogation`
- **AND** the body SHALL contain a `design-gate-state` artifact
- **AND** the body SHALL end with a terminal `pipeline-attest` marker for kind `design-interrogation`
- **AND** `isVerifiedPipelineOutput` SHALL return true for the rendered body

#### Scenario: Real operator comment after design-gate still gates
- **WHEN** a free-form human comment without pipeline structural markers is posted after the plan (including after design-gate progress comments)
- **THEN** that comment SHALL remain unacknowledged human input
- **AND** the pipeline SHALL require re-plan or a trusted acknowledgement / override path before proceeding

#### Scenario: Forged design-gate-shaped comment from a non-trusted author still gates
- **WHEN** a non-trusted author posts a body that mimics `## Design Interrogation` and/or copies design-gate markers after the plan anchor
- **THEN** the comment SHALL be counted as unacknowledged human input
- **AND** the pipeline SHALL NOT treat structural mimicry alone as self-exclusion
