## ADDED Requirements

### Requirement: Fleet delivery is an opt-in config block that preserves existing behavior

The pipeline SHALL accept an optional top-level `fleet` configuration block that enables authenticated
durable delivery of fleet envelopes to a customer-controlled collector, carrying fleet identity
(`tenant_id`, `installation_id`), the collector endpoint, a scoped ingest credential reference, and
spool/retry/overflow settings. The `fleet` block SHALL be a strict schema object that fails fast on
unknown keys or invalid values. When no `fleet` block is configured, the pipeline SHALL behave exactly
as today, and the existing `event_sink.command`, `additive`/`exclusive` modes, and local `scoreboard`
and `improve` behavior SHALL remain unchanged.

#### Scenario: no fleet block leaves behavior unchanged

- **WHEN** no `fleet` block is configured
- **THEN** the pipeline SHALL exhibit its current behavior with no fleet delivery active
- **AND** `event_sink.command`, `additive`/`exclusive` modes, and local `scoreboard`/`improve` SHALL be
  unchanged

#### Scenario: invalid fleet config fails fast

- **WHEN** the `fleet` block sets an unknown key or an invalid value
- **THEN** config resolution SHALL throw a schema error identifying the offending field rather than
  silently using a wrong value

### Requirement: Delivery is at-least-once once spooled, with idempotency and acknowledgements

Each fleet envelope SHALL be delivered to the collector at least once, once it is successfully admitted
to the durable local spool that fleet delivery writes to when active. An envelope SHALL be retired from the spool
only upon a collector acknowledgement, and delivery SHALL survive process restart by replaying
un-acknowledged spooled envelopes. Each envelope SHALL carry a deterministic idempotency key derived
from `(tenant_id, installation_id, run_id, seq)` (or an equivalent event-content digest) so that
duplicate delivery is deduplicable and does not skew metrics. The at-least-once guarantee applies only
to envelopes admitted to the spool; an envelope dropped by the overflow policy (see below) before or
after admission is accounted telemetry loss, not a violation of at-least-once.

#### Scenario: envelope retires only on acknowledgement

- **WHEN** a fleet envelope is delivered to the collector
- **THEN** it SHALL be retired from the spool only after the collector acknowledges it
- **AND** an un-acknowledged envelope SHALL remain spooled for retry

#### Scenario: spool replays after restart

- **WHEN** the process restarts with un-acknowledged envelopes in the spool
- **THEN** delivery SHALL replay those envelopes rather than dropping them

#### Scenario: idempotency key is deterministic

- **WHEN** the same event is delivered more than once
- **THEN** each delivery SHALL carry the same deterministic idempotency key
- **AND** the collector SHALL be able to deduplicate on that key without skewing metrics

### Requirement: Delivery has bounded retry/backoff and explicit, accounted overflow behavior

Fleet delivery SHALL retry failed deliveries with bounded backoff and SHALL bound the local spool with
an explicit overflow policy — documented drop-oldest or back-pressure — that SHALL NOT allow unbounded
spool growth. A customer SHALL select the overflow policy via the `fleet` config; the pipeline SHALL NOT
silently mix the two. When the overflow policy engages, delivery SHALL emit a machine-readable
diagnostic identifying the affected envelope(s) (at minimum `run_id` and `seq`) and a running
overflow-drop count, exposed through the delivery-health diagnostics (see below) as accounted telemetry
loss rather than silent data loss. Under `drop-oldest`, the dropped envelope is always the
oldest-`seq`-per-run entry currently in the spool; under `back-pressure`, no envelope is dropped and
event emission SHALL continue without changing stage outcomes (per the non-fatal requirement below)
even while the spool is full.

#### Scenario: failed delivery retries with bounded backoff

- **WHEN** a delivery attempt fails
- **THEN** delivery SHALL retry with bounded backoff rather than retrying unboundedly or giving up
  silently

#### Scenario: spool overflow is explicit and observable

- **WHEN** the spool reaches its configured bound under `drop-oldest`
- **THEN** the oldest spooled envelope SHALL be dropped rather than the spool growing without bound
- **AND** a machine-readable diagnostic SHALL identify the dropped envelope's `run_id`/`seq` and
  increment the delivery-health drop count

#### Scenario: back-pressure overflow drops nothing

- **WHEN** the spool reaches its configured bound under `back-pressure`
- **THEN** no envelope SHALL be dropped
- **AND** event emission SHALL continue without changing any Pipeline stage outcome

### Requirement: Delivery failures never change a stage outcome and delivery health is observable

A fleet-delivery failure — collector unreachable, rejected, or timing out — SHALL NOT change any
Pipeline stage outcome, abort a run, or block subsequent events, consistent with the #343 non-fatal
sink contract. Delivery health SHALL be exposed through machine-readable diagnostics that report at
minimum delivery lag, drop count, rejected-schema count, and the last successful acknowledgement.

#### Scenario: sink outage does not change a stage outcome

- **WHEN** the collector is unreachable or rejects deliveries during a run
- **THEN** the run SHALL reach the same stage outcome it would reach with no fleet delivery configured
- **AND** the failure SHALL be surfaced as a non-fatal condition, not thrown out of event emission

#### Scenario: delivery health is machine-readable

- **WHEN** delivery health is queried
- **THEN** the diagnostics SHALL report delivery lag, drop count, rejected-schema count, and the last
  successful acknowledgement in a machine-readable form

### Requirement: Delivery authenticates with scoped ingest credentials

Fleet delivery SHALL authenticate to the collector using a scoped ingest credential bound to one
tenant and installation, referenced by configuration rather than inlined as a long-lived secret. The
credential SHALL be rotatable and revocable without changing repository configuration.

#### Scenario: delivery presents a scoped credential

- **WHEN** an envelope is delivered
- **THEN** delivery SHALL present a scoped ingest credential bound to the configured tenant and
  installation

#### Scenario: credential rotates without repository-config change

- **WHEN** a scoped ingest credential is rotated or revoked
- **THEN** the change SHALL take effect without editing repository configuration
- **AND** a revoked credential's subsequent deliveries SHALL be refused by the collector
