## MODIFIED Requirements

### Requirement: The profile, not file config, selects the per-role harness
At stage execution, the implementer-role harness (`harnesses.implementer`) SHALL run planning/implementation/fix and the reviewer-role harness (`harnesses.reviewer`) SHALL run review, dispatched by `invoke(...)`. The implementer harness SHALL come from the profile and SHALL NOT be overridable by `.github/pipeline.yml`. The reviewer harness SHALL default to the profile's value but MAY be overridden at config-resolve time by the `review_harness` key in `.github/pipeline.yml` (see `pipeline-configuration` and `configurable-review-harness`).

#### Scenario: role drives CLI invocation with no override
- **WHEN** planning runs under the `claude` profile and no `review_harness` key is set
- **THEN** the implementer CLI invoked SHALL be `claude`
- **AND** the subsequent review SHALL invoke the `codex` CLI

#### Scenario: reviewer overridden by repo config
- **WHEN** the `claude` profile is active and `.github/pipeline.yml` sets `review_harness: custom-reviewer`
- **THEN** the implementer CLI SHALL be `claude`
- **AND** review SHALL invoke `custom-reviewer` rather than the profile's default `codex`
