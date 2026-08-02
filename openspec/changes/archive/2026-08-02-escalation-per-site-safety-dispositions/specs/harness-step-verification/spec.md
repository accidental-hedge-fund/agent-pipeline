## ADDED Requirements

### Requirement: Pipeline-imposed format failures SHALL self-correct with a bounded rewrite

Pipeline-imposed format failures SHALL self-correct with a bounded rewrite before parking when
the site is dispositioned `transient-retryable`. Covered contracts are those the engine fully
owns — including fix commit subject format, implement commit issue-ref format, and required
verdict / plan-revision section headers the pipeline defines. The engine SHALL rewrite the owned
format and re-validate within a small finite budget (at least one attempt, hard-capped by
configuration or a single rewrite pass). Human prose, review finding bodies, and
non-pipeline-owned content SHALL NOT be rewritten by this path. On exhaustion, the failure SHALL
escalate as an engine-owned format / implementation diagnostic, not as product human authority.

#### Scenario: Fix commit subject format self-fixes once

- **WHEN** a fix commit is present but its subject fails the pipeline-owned subject format check
- **AND** the site is dispositioned `transient-retryable`
- **THEN** the engine SHALL rewrite the subject to the owned format and re-validate
- **AND** on success SHALL continue without a product `needs-human` park for that format alone

#### Scenario: Human prose is not rewritten

- **WHEN** a failure concerns human-authored issue text or review finding content rather than a
  pipeline-owned format
- **THEN** the format self-fix path SHALL NOT rewrite that content
- **AND** normal stage handling for that failure class SHALL apply

#### Scenario: Exhausted format self-fix stays engine-owned

- **WHEN** the bounded format self-fix still fails validation
- **THEN** the stage SHALL escalate with a typed engine-owned / implementation diagnostic
- **AND** SHALL NOT emit `human_intervention` solely for the format failure
)