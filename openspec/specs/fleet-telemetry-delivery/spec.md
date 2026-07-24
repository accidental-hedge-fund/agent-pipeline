# fleet-telemetry-delivery Specification

## Purpose
TBD - created by archiving change fleet-telemetry-aggregation. Update Purpose after archive.
## Requirements
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
only upon a collector acknowledgement **of that specific envelope**, and delivery SHALL survive process
restart by replaying un-acknowledged spooled envelopes. Each envelope SHALL carry its own deterministic
idempotency key, embedded in the envelope itself (not a request-level header), derived from
`(tenant_id, installation_id, run_id, seq)` (or an equivalent event-content digest) so that duplicate
delivery is deduplicable and does not skew metrics. When multiple envelopes are delivered in one batch
request, each envelope SHALL retire independently based on its own per-envelope result in the batch
response — a batch SHALL NOT be treated as all-or-nothing, so a partially rejected batch retires only
the accepted envelopes plus any **terminally** rejected ones (see below), and leaves transiently
rejected/unacknowledged envelopes spooled for retry. A rejection whose `reason_code` is terminal
(`malformed_envelope`, `unsupported_major_version`, `cross_tenant_scope` — a rejection that can never
succeed on retry) SHALL be retired from the spool as an **accounted rejected loss**: its `reason_code`
and correlation are recorded in the delivery-health accounting and the envelope is removed, distinct
from an acknowledgement and distinct from a transient rejection (e.g. `unauthorized`, which remains
spooled until the credential is refreshed). This keeps the bounded spool from filling with un-retryable
records while never silently discarding a record that could still be delivered.
The at-least-once guarantee applies to every envelope admitted to the spool: an admitted, un-acknowledged
envelope SHALL NOT be evicted by the overflow policy. Overflow is therefore an admission-control decision
only — when the durable spool is at capacity, a newly produced envelope that cannot be admitted is
accounted telemetry loss **at admission time** (recorded in delivery-health accounting), while every
already-admitted envelope is retained until its own acknowledgement (or terminal-rejection retirement)
removes it. The overflow policy governs which incoming envelopes are refused admission, never the
deletion of already-admitted ones.

#### Scenario: envelope retires only on acknowledgement

- **WHEN** a fleet envelope is delivered to the collector
- **THEN** it SHALL be retired from the spool only after the collector acknowledges that envelope
- **AND** an un-acknowledged envelope SHALL remain spooled for retry

#### Scenario: batch delivery retires accepted and terminally-rejected envelopes independently

- **WHEN** a batch of envelopes is delivered and the collector's per-envelope results accept some,
  terminally reject others (`malformed_envelope`, `unsupported_major_version`, `cross_tenant_scope`),
  and transiently reject the rest (e.g. `unauthorized`)
- **THEN** each accepted envelope SHALL retire from the spool as delivered, correlated by its result's
  `index`
- **AND** each terminally-rejected envelope SHALL retire from the spool as an **accounted rejected loss**
  recording its `reason_code`, so an un-retryable record never fills the bounded spool
- **AND** each transiently-rejected or unacknowledged envelope SHALL remain spooled for retry

#### Scenario: malformed envelope is correlated without a valid key

- **WHEN** a submitted envelope is rejected as `malformed_envelope` and its embedded `idempotency_key`
  is absent or invalid
- **THEN** the sender SHALL correlate the rejection to the spooled record by the result's zero-based
  `index` in the submitted batch (the result carrying `"idempotency_key": null`)
- **AND** the sender SHALL terminally retire exactly that record and no other

#### Scenario: spool replays after restart

- **WHEN** the process restarts with un-acknowledged envelopes in the spool
- **THEN** delivery SHALL replay those envelopes rather than dropping them

#### Scenario: idempotency key is deterministic

- **WHEN** the same event is delivered more than once
- **THEN** each delivery SHALL carry the same deterministic idempotency key
- **AND** the collector SHALL be able to deduplicate on that key without skewing metrics

### Requirement: Delivery has bounded retry/backoff and explicit, accounted overflow behavior

Fleet delivery SHALL retry failed deliveries with bounded backoff and SHALL bound the local spool with
an explicit **admission-control** overflow policy — documented `reject-new` or `back-pressure` — that
SHALL NOT allow unbounded spool growth and SHALL NOT evict an already-admitted, unacknowledged envelope
(consistent with the once-admitted at-least-once guarantee above). A customer SHALL select the overflow
policy via the `fleet` config; the pipeline SHALL NOT silently mix the two. When the overflow policy
engages, delivery SHALL emit a machine-readable diagnostic identifying the affected (refused) envelope
(at minimum `run_id` and `seq`) and a running overflow-drop count, exposed through the delivery-health
diagnostics (see below) as accounted telemetry loss rather than silent data loss. Under `reject-new`,
when the spool is at its configured bound the **newly produced** envelope is refused admission and
accounted as pre-admission loss; every already-admitted envelope is retained until its own acknowledgement
or terminal-rejection retirement. Under `back-pressure`, admission of a new envelope into a full spool
SHALL be delayed, bounded by a configured `admission_timeout`, applied only to the fleet-delivery producer
call (never to the Pipeline stage itself, consistent with the non-fatal requirement below); if the timeout
elapses before spool space frees, the new envelope SHALL be dropped as accounted pre-admission loss —
identified by `run_id`/`seq` and counted in the same overflow-drop count — rather than growing the spool,
evicting an admitted envelope, or blocking the stage.

#### Scenario: failed delivery retries with bounded backoff

- **WHEN** a delivery attempt fails
- **THEN** delivery SHALL retry with bounded backoff rather than retrying unboundedly or giving up
  silently

#### Scenario: spool overflow is explicit and observable

- **WHEN** the spool reaches its configured bound under `reject-new`
- **THEN** the newly produced envelope SHALL be refused admission rather than the spool growing without
  bound or an already-admitted envelope being evicted
- **AND** a machine-readable diagnostic SHALL identify the refused envelope's `run_id`/`seq` and
  increment the delivery-health drop count

#### Scenario: back-pressure overflow delays admission within a bounded timeout

- **WHEN** the spool reaches its configured bound under `back-pressure` and space frees before the
  configured `admission_timeout` elapses
- **THEN** the new envelope SHALL be admitted once space frees
- **AND** event emission SHALL continue without changing any Pipeline stage outcome

#### Scenario: back-pressure overflow drops the new envelope after the admission timeout

- **WHEN** the spool remains full under `back-pressure` for longer than the configured
  `admission_timeout`
- **THEN** the new envelope SHALL be dropped as accounted pre-admission loss, identified by `run_id`/`seq`
  and counted in the overflow-drop count
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

