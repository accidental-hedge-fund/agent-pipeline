## ADDED Requirements

### Requirement: Deterministic candidate qualification SHALL precede remote fixture creation

Factory-release preparation SHALL run or re-observe exact-candidate installed-CLI qualification before creating a remote FRG fixture issue or PR. Missing or failed qualification SHALL stop at a typed preflight defect with the artifact path and failed cells. It SHALL NOT create, replace, or dispatch a remote fixture pack. A passing qualification artifact SHALL be reused idempotently for the same candidate.

#### Scenario: Qualification failure creates no fixtures

- **WHEN** exact-candidate installed-CLI qualification is missing, stale, malformed, or has a failed required case
- **THEN** factory-release preparation SHALL fail before its first remote fixture mutation
- **AND** no successor fixture pair SHALL be created

#### Scenario: Passing qualification is reused

- **WHEN** the same candidate and matrix version are prepared again after qualification passed
- **THEN** preparation SHALL validate and reuse the existing artifact
- **AND** it SHALL NOT rerun qualification or create an additional fixture pair solely to rediscover local faults

### Requirement: Remote FRG SHALL be one final candidate-bound canary

After deterministic qualification passes, a release candidate MAY create at most one active remote fixture pair. A canary failure SHALL retain its pack identity and artifacts for replay and diagnosis. Automatic retry SHALL reconcile or resume that same pack; it SHALL NOT manufacture a fresh pair for the unchanged candidate. A changed candidate SHALL require new deterministic qualification before one successor canary is permitted, and the prior pack SHALL be reconciled first.

#### Scenario: Same-candidate retry reuses the pack

- **WHEN** candidate `C` has a failed or interrupted canary pack with persisted identity
- **AND** release preparation is retried without changing `C`
- **THEN** preparation SHALL replay or resume the same pack artifacts
- **AND** it SHALL NOT create a new pair

#### Scenario: Changed candidate gets one successor only after qualification

- **WHEN** candidate changes from `C1` to `C2`
- **THEN** the `C1` pack SHALL be reconciled before any successor mutation
- **AND** exact-candidate qualification for `C2` SHALL pass before the single `C2` canary pair is created
