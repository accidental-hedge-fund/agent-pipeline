# fleet-collector-contract Specification

## Purpose
TBD - created by archiving change fleet-telemetry-aggregation. Update Purpose after archive.
## Requirements
### Requirement: Collector implements a versioned wire transport profile

The collector SHALL expose an authenticated HTTPS ingest endpoint accepting one envelope, or, under the
batch profile, a JSON array of envelopes, per request, bound to the canonical field types/limits and
per-envelope idempotency-key encoding defined in the design's wire transport profile (`design.md` D10).
For a single-envelope request, the collector SHALL respond to a successful ingest with a `202`-class
acknowledgement carrying the envelope's idempotency key, and to a rejection with a `4xx`-class response
carrying a machine-readable `reason_code` drawn from a fixed enum and the same idempotency key for
correlation. For a batch request, the collector SHALL respond `207 Multi-Status` with a per-envelope
`results` array — one entry per submitted envelope, each keyed by that envelope's own idempotency key and
carrying its own `accepted`/`rejected` status and `reason_code` — so a partially invalid batch is never
treated as all-or-nothing. The collector SHALL advertise its supported `envelope_version` majors and
request-batching mode at a capabilities endpoint.

#### Scenario: acknowledgement correlates to the request

- **WHEN** the collector accepts a single-envelope request
- **THEN** it SHALL respond with a `202`-class acknowledgement carrying that envelope's idempotency key

#### Scenario: rejection carries a machine-readable reason code

- **WHEN** the collector rejects a single-envelope request
- **THEN** it SHALL respond with a `4xx`-class response carrying a `reason_code` from a fixed enum and
  the envelope's idempotency key

#### Scenario: batch response carries a per-envelope result

- **WHEN** the collector receives a batch request containing a mix of valid and invalid envelopes
- **THEN** it SHALL respond `207 Multi-Status` with one result per submitted envelope, each keyed by that
  envelope's own idempotency key and carrying its own accept/reject status and reason code
- **AND** the acceptance of one envelope in the batch SHALL NOT be affected by the rejection of another

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

### Requirement: Collector enforces run-id uniqueness within an installation

The collector SHALL treat `run_id` as unique within an installation and SHALL NOT silently merge or
interleave envelopes from two distinct runs that present the same `run_id` under the same
`installation_id`. Distinctness SHALL be decided by an immutable `run_origin` marker carried on every
envelope — an identifier assigned once at run creation (for example a random per-run-instance UUID, or
`host_id` combined with the run's creation timestamp) that is stable across every envelope of that run
and differs between two runs that reuse the same `run_id`. On first ingest of a `(installation_id,
run_id)` pair the collector SHALL record that pair's `run_origin`, and before de-duplicating or merging
any subsequent envelope by its idempotency key it SHALL compare that envelope's `run_origin` against the
recorded one. An envelope whose `run_origin` matches SHALL be reconstructed into the run's order by
`(run_id, seq)` **regardless of arrival order** — out-of-order or delayed delivery, including a lower
`seq` arriving after a higher one, SHALL NOT be treated as a conflict. An envelope whose `run_origin`
differs SHALL be flagged as a duplicate-run-id conflict for that `(installation_id, run_id)` pair, SHALL
NOT be interleaved into or silently de-duplicated against the first run's stream, and SHALL be surfaced
through the delivery-health diagnostics.

#### Scenario: delayed low-seq envelope is reordered, not flagged

- **WHEN** an envelope with a low `seq` (e.g. `seq=0`) arrives after envelopes with much higher `seq`
  values for the same `(installation_id, run_id, run_origin)` have already advanced the run
- **THEN** the collector SHALL reconstruct it into the run's order by `(run_id, seq)`
- **AND** it SHALL NOT flag a conflict, because out-of-order arrival is explicitly supported

#### Scenario: duplicate run-id from two hosts is flagged, not merged

- **WHEN** two distinct hosts each emit envelopes using the same `run_id` under the same
  `installation_id` but with different `run_origin` markers
- **THEN** the collector SHALL flag a duplicate-run-id conflict for that `(installation_id, run_id)` pair
  on the first envelope whose `run_origin` mismatches the recorded one
- **AND** it SHALL NOT silently interleave or de-duplicate the two hosts' events into one merged per-run order

### Requirement: Collector writes to customer-owned storage with no upstream path

The reference collector SHALL write ingested telemetry to customer-owned storage on the customer's
control plane, and SHALL provide no path that forwards customer fleet telemetry to Agent Pipeline
maintainers. A customer MAY deploy the reference collector or implement the same contract against their
own storage.

#### Scenario: telemetry stays customer-owned

- **WHEN** the collector ingests fleet telemetry
- **THEN** it SHALL write to customer-owned storage
- **AND** it SHALL NOT forward the telemetry to Agent Pipeline maintainers

### Requirement: Collector implements an authenticated query/report endpoint

The collector SHALL expose an authenticated `POST /fleet/v1/query` endpoint, bound to the query request
and response shape defined in the design's query profile (`design.md` D11): a scoped query credential in
`Authorization: Bearer`, a request body carrying a required `time_window` and optional `filter`,
`group_by`, and `page` fields, and a response carrying aggregated `metrics`, a `lineage` map from each
metric's id to its contributing `run_id`s, and a `next_cursor` for pagination. The credential's bound
tenant SHALL be resolved from the credential itself, never from a request field, and a request whose
`filter` names an installation outside the credential's tenant scope SHALL be refused with a `403` and
the `cross_tenant_scope` reason code, returning no data for the out-of-scope installation. This is the
only transport through which `pipeline fleet report` (see the `fleet-reporting` capability) retrieves
collected telemetry.

#### Scenario: a scoped query returns paginated, lineage-preserving metrics

- **WHEN** a query credential scoped to tenant A requests a report for a time window
- **THEN** the collector SHALL respond with metrics, a lineage map from each metric to its contributing
  `run_id`s, and a `next_cursor` that is `null` once the last page has been returned

#### Scenario: cross-tenant filter is refused

- **WHEN** a query credential scoped to tenant A submits a `filter` naming an installation belonging to
  tenant B
- **THEN** the collector SHALL refuse the request with a `403` and the `cross_tenant_scope` reason code
- **AND** it SHALL NOT return tenant B's data

