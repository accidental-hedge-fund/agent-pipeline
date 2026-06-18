## ADDED Requirements

### Requirement: `plan.json.milestones[]` SHALL be populated per `release_model` and SHALL NOT be hardcoded empty

The `milestones[]` field in `plan.json` SHALL contain entries derived from the configured `release_model` (see `roadmap-release-model` capability) whenever the backlog has rankable issues. The field SHALL NOT be returned as a hardcoded empty array. The content structure (semver version lane vs. theme/epic group) is fully governed by `release_model`; this requirement asserts only that the field is populated, not its internal structure.

#### Scenario: milestones[] is non-empty after a semver roadmap run with rankable issues

- **WHEN** `pipeline roadmap` runs with `release_model: semver` (or `release_model` absent) and the backlog has at least one rankable issue
- **THEN** `plan.json.milestones[]` SHALL contain at least one entry
- **AND** each entry SHALL have a non-empty `title` and a non-empty `issue_numbers[]` array

#### Scenario: milestones[] is non-empty after a continuous roadmap run

- **WHEN** `pipeline roadmap` runs with `release_model: continuous` and the backlog has at least one issue
- **THEN** `plan.json.milestones[]` SHALL contain at least one entry
- **AND** no entry's `title` SHALL be a semver version string
