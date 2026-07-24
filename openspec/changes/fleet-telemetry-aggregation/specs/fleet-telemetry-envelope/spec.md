## ADDED Requirements

### Requirement: Fleet envelope wraps sanitized run events with stable identity and ordering

The fleet telemetry envelope SHALL wrap each sanitized run event (the record delivered through the
`appendEvent` producer path reused from #343) with a header carrying bounded `tenant_id`,
`installation_id`, pseudonymous `repo_id`, pseudonymous `host_id`, `pipeline_version`, `run_id`, the
event `schema_version`, an explicit `envelope_version`, and a per-run monotonically increasing `seq`.
The wrapped payload SHALL be byte-identical to the line written to `events.jsonl` for that same event,
and the envelope SHALL add no fields to the payload itself.

#### Scenario: envelope carries stable fleet identity

- **WHEN** a run event is wrapped in a fleet envelope
- **THEN** the envelope SHALL carry `tenant_id`, `installation_id`, pseudonymous `repo_id`, pseudonymous
  `host_id`, `pipeline_version`, `run_id`, event `schema_version`, and `envelope_version`
- **AND** the wrapped payload SHALL be byte-identical to the event's `events.jsonl` line

#### Scenario: per-run sequence gives deterministic ordering

- **WHEN** multiple events are wrapped for the same run
- **THEN** each envelope SHALL carry a per-run monotonically increasing `seq`
- **AND** a consumer SHALL be able to reconstruct append order from `(run_id, seq)` even when envelopes
  arrive out of order

#### Scenario: envelope adds no payload fields and preserves schema version

- **WHEN** an event is wrapped in a fleet envelope
- **THEN** the wrapped event payload SHALL carry no fields introduced for fleet delivery
- **AND** the event `schema_version` SHALL be preserved unchanged from the local record

### Requirement: Repository and host identity are pseudonymous and derived deterministically

The envelope's `repo_id` and `host_id` SHALL be pseudonymous identifiers derived deterministically per
installation so that the same repository or host maps to the same identifier across runs and hosts,
and the raw repository name and local filesystem paths SHALL be excluded from the envelope by default.
Resolution of a pseudonymous `repo_id` to a friendly name SHALL happen only in customer-controlled
locations and SHALL NOT be part of the fleet payload.

#### Scenario: same repository yields a stable pseudonymous id

- **WHEN** two runs for the same repository under the same installation are wrapped
- **THEN** both envelopes SHALL carry the same pseudonymous `repo_id`
- **AND** neither envelope SHALL contain the raw repository name or a local filesystem path

#### Scenario: friendly-name mapping is not in the payload

- **WHEN** an operator maps a pseudonymous `repo_id` to a friendly name
- **THEN** that mapping SHALL be resolved from customer-controlled local or collector metadata
- **AND** the fleet payload SHALL NOT contain the mapping

### Requirement: Fleet payload excludes raw prompts, output, source, secrets, environment, and human identity

The fleet envelope SHALL NOT carry raw prompts or model output, source code, secrets, arbitrary
environment values, repository names, local paths, or human identity. This exclusion SHALL be inherited
from the existing write-time injection denylist and secret redaction that already screen the
`appendEvent` records, and the envelope SHALL NOT re-derive or enrich the payload in a way that could
reintroduce excluded content.

#### Scenario: excluded content never appears in a payload

- **WHEN** a fleet envelope is produced for any event type
- **THEN** the payload SHALL NOT contain raw prompts/model output, source code, secrets, arbitrary
  environment values, repository names, local paths, or human identity
- **AND** the payload SHALL already be screened by the injection denylist and secret redaction

#### Scenario: envelope does not re-derive the payload

- **WHEN** an event is wrapped
- **THEN** the wrapped payload SHALL be the already-screened record, not a re-derived or enriched copy
