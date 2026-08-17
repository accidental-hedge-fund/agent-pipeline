## ADDED Requirements

### Requirement: Transient-retryable push wrappers SHALL emit the classified failure reason
A `transient-retryable` push site SHALL keep its inventory disposition for true transient transport blips (HTTP 5xx after currency re-sync). Disposition SHALL NOT force every `push-failed` outcome to `transient-infra`. When the observed push stderr is the non-fast-forward class (`non-fast-forward`, `rejected`, or `fetch first`), the wrapper SHALL emit canonical reason `workflow-state` with `head_drift: true` even when the inventory row’s default canonical reason is `transient-infra`. Inventory site `stages.fix:push-failed#0` MAY remain `transient-retryable`.

#### Scenario: Inventory default does not reclassify non-fast-forward
- **WHEN** site `stages.fix:push-failed#0` is dispositioned `transient-retryable` with inventory canonical reason `transient-infra`
- **AND** the push wrapper observes the #1038 non-fast-forward fixture
- **THEN** the emitted reason SHALL be `workflow-state` with `head_drift: true`
- **AND** the site SHALL NOT retry that failure as a transient blip

#### Scenario: HTTP 502 on the same site still retries
- **WHEN** the same `transient-retryable` push site fails once with HTTP 502 and no non-fast-forward tokens
- **AND** currency re-sync still owns the expected local HEAD
- **THEN** the wrapper SHALL retry with backoff
- **AND** a success within budget SHALL NOT park the issue as `push-failed`
