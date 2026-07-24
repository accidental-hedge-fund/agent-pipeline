## ADDED Requirements

### Requirement: Collector implements a versioned wire transport profile

The collector SHALL expose an authenticated HTTPS ingest endpoint accepting one envelope (or a JSON
array of envelopes) per request, bound to the canonical field types/limits and idempotency-key encoding
defined in the design's wire transport profile (`design.md` D10). The collector SHALL respond to a
successful ingest with a `202`-class acknowledgement carrying the envelope's idempotency key, and to a
rejection with a `4xx`-class response carrying a machine-readable `reason_code` drawn from a fixed enum
and the same idempotency key for correlation. The collector SHALL advertise its supported
`envelope_version` majors and request-batching mode at a capabilities endpoint.

#### Scenario: acknowledgement correlates to the request

- **WHEN** the collector accepts an envelope
- **THEN** it SHALL respond with a `202`-class acknowledgement carrying that envelope's idempotency key

#### Scenario: rejection carries a machine-readable reason code

- **WHEN** the collector rejects an envelope
- **THEN** it SHALL respond with a `4xx`-class response carrying a `reason_code` from a fixed enum and
  the envelope's idempotency key

#### Scenario: capabilities are advertised

- **WHEN** a sender queries the collector's capabilities endpoint
- **THEN** the response SHALL list the supported `envelope_version` majors and batching mode

### Requirement: Collector validates schemas and rejects malformed or unsupported envelopes

The reference collector SHALL validate each received fleet envelope against the known envelope schema
and SHALL reject any malformed envelope or any envelope whose major `envelope_version` it does not
support, returning a machine-readable rejection reason. Rejected envelopes SHALL NOT be stored, and
rejection SHALL be counted toward the delivery-health rejected-schema metric.

#### Scenario: malformed envelope is rejected

- **WHEN** the collector receives a malformed envelope
- **THEN** it SHALL reject the envelope with a machine-readable reason
- **AND** it SHALL NOT store the envelope

#### Scenario: unsupported major version is rejected

- **WHEN** the collector receives an envelope whose major `envelope_version` it does not support
- **THEN** it SHALL reject the envelope with a machine-readable reason indicating the unsupported version

### Requirement: Collector supports forward-compatible optional fields under an explicit migration policy

The collector SHALL accept envelopes that carry unknown optional fields within a supported major
version rather than rejecting them, and SHALL follow an explicit, documented migration policy for how
envelope and schema versions evolve. Forward-compatible acceptance SHALL NOT weaken rejection of
malformed or unsupported-major-version envelopes.

#### Scenario: unknown optional field is accepted

- **WHEN** the collector receives an envelope with an unknown optional field within a supported major
  version
- **THEN** it SHALL accept and store the envelope rather than rejecting it

#### Scenario: migration policy is explicit

- **WHEN** the envelope or schema version evolves
- **THEN** the collector's documented migration policy SHALL define how the new version is handled
  relative to supported versions

### Requirement: Collector enforces tenant isolation

The collector SHALL enforce that a scoped write credential can write only its own tenant and
installation's data, and a scoped query credential can read only its own tenant's data. One tenant or
installation SHALL NOT be able to write to or query another tenant's data.

#### Scenario: cross-tenant write is refused

- **WHEN** a write credential scoped to tenant A attempts to write data attributed to tenant B
- **THEN** the collector SHALL refuse the write

#### Scenario: cross-tenant query is refused

- **WHEN** a query credential scoped to tenant A attempts to read tenant B's data
- **THEN** the collector SHALL refuse the query and SHALL NOT return tenant B's data

### Requirement: Collector deduplicates deterministically and reconstructs per-run order

The collector SHALL deduplicate received envelopes on their deterministic idempotency key so that an
event delivered more than once is stored and counted at most once, and duplicate delivery SHALL NOT
skew aggregated metrics. The collector SHALL reconstruct per-run event order from `(run_id, seq)`
regardless of arrival order.

#### Scenario: duplicate delivery does not double-count

- **WHEN** the same event is delivered to the collector more than once
- **THEN** the collector SHALL store and count it at most once
- **AND** aggregated metrics SHALL NOT be skewed by the duplicate

#### Scenario: out-of-order events are re-ordered per run

- **WHEN** envelopes for one run arrive out of `seq` order
- **THEN** the collector SHALL reconstruct their order from `(run_id, seq)`

### Requirement: Collector writes to customer-owned storage with no upstream path

The reference collector SHALL write ingested telemetry to customer-owned storage on the customer's
control plane, and SHALL provide no path that forwards customer fleet telemetry to Agent Pipeline
maintainers. A customer MAY deploy the reference collector or implement the same contract against their
own storage.

#### Scenario: telemetry stays customer-owned

- **WHEN** the collector ingests fleet telemetry
- **THEN** it SHALL write to customer-owned storage
- **AND** it SHALL NOT forward the telemetry to Agent Pipeline maintainers
