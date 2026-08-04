## ADDED Requirements

### Requirement: Stage accounting SHALL thread recovered telemetry from any fixture-verified jsonl adapter

The pipeline SHALL thread recovered telemetry into stage accounting for every fixture-verified
machine-readable local-CLI adapter. When such an adapter's `parseTelemetry` recovers a numeric
per-call cost, the emitted `stage_accounting` record SHALL use `cost_source: "actual"` and
`cost_usd` equal to that value, subject to the existing allowlist and sanitization rules. When the
adapter recovers token counters without a numeric cost, those counters SHALL appear in `usage` and
`cost_source` SHALL NOT become `actual` solely from tokens.

This requirement applies to every registered adapter that meets the fixture-verification bar —
including adapters beyond the historical `claude` and `codex` pair — without a named-provider
special case. Adapters that declare `telemetry: "none"` or whose capture is unparseable SHALL
continue to record `cost_source: "estimated"` or `cost_source: "unknown"` exactly as before.

#### Scenario: Non-claude jsonl adapter with cost records actual

- **WHEN** a registered adapter other than `claude` declares machine-readable telemetry, accounting
  is enabled, and its verified envelope reports a numeric per-call cost
- **THEN** the emitted `stage_accounting` event SHALL contain `cost_source: "actual"`
- **AND** `cost_usd` SHALL equal the reported cost
- **AND** the path SHALL NOT require a hard-coded adapter-name branch on `claude` alone to accept
  actual cost

#### Scenario: Telemetry-none adapter stays unknown or estimated

- **WHEN** a stage runs an adapter that declares `telemetry: "none"` with accounting enabled and no
  explicit estimate
- **THEN** the emitted record SHALL contain `cost_source: "unknown"` and `cost_usd: null`
- **AND** it SHALL NOT invent actual cost from the requested model or prompt size

#### Scenario: Tokens without cost do not become actual

- **WHEN** an adapter's telemetry recovers token counters but no numeric cost
- **THEN** the record's `usage` object SHALL contain the reported counters
- **AND** `cost_source` SHALL NOT be `actual`

### Requirement: Stage accounting SHALL persist probed adapter CLI version when known

The pipeline SHALL persist the probed adapter CLI version on stage accounting when known. When the
once-per-run CLI version probe supplies a version string for the invoked adapter and accounting is
enabled, the stage accounting record SHALL carry that value in `adapter_cli_version` (or the
equivalent existing provenance field). When the probe is unavailable, the field SHALL be omitted
or null — not fabricated.

#### Scenario: Probed version appears on the accounting record

- **WHEN** a harness invocation with accounting enabled has a successful cached CLI version probe
- **THEN** the emitted `stage_accounting` record SHALL include `adapter_cli_version` equal to the
  probed version

#### Scenario: Missing probe omits version without failing the stage

- **WHEN** a harness invocation with accounting enabled has no CLI version probe result
- **THEN** `adapter_cli_version` SHALL be omitted or null
- **AND** the stage SHALL NOT enter a blocked or error state solely because the version is missing

### Requirement: Stage accounting SHALL persist resolved model and throttle only when recovered

The pipeline SHALL persist resolved model and throttle on stage accounting only when recovered
from adapter telemetry. When adapter telemetry recovers a resolved model or a throttle signal, the
stage accounting record SHALL carry `resolved_model` and `throttled` (or equivalent fields) with
those values. When telemetry does not recover them, the fields SHALL be null/omitted. The pipeline
SHALL NOT copy the requested model into `resolved_model` and SHALL NOT coerce missing throttle to
`false` or missing numeric usage to zero.

#### Scenario: Recovered resolved model is recorded

- **WHEN** `parseTelemetry` returns a non-null `resolvedModel` for an accounted invocation
- **THEN** the emitted record SHALL include that value as `resolved_model`

#### Scenario: Unrecovered resolved model stays null

- **WHEN** `parseTelemetry` returns `resolvedModel: null` for an accounted invocation that had a
  non-null requested model
- **THEN** the emitted record SHALL omit `resolved_model` or set it null
- **AND** it SHALL NOT equal the requested model solely by echo

#### Scenario: Unrecovered throttle stays null

- **WHEN** `parseTelemetry` returns `throttled: null`
- **THEN** the emitted record's throttle field SHALL be null/omitted
- **AND** it SHALL NOT be written as `false`
