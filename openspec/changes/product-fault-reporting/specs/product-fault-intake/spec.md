## ADDED Requirements

### Requirement: The intake service SHALL authenticate submissions without broad client GitHub permissions

The maintainer-controlled intake service SHALL accept product-fault submissions authenticated by a
submission-scoped credential that does not require any GitHub token or broad permission on the
client machine. The client SHALL hold no upstream issue-creation permission; the intake service is
the sole trust boundary between client submissions and any maintainer-side GitHub action.

#### Scenario: submission authenticated without a GitHub token

- **WHEN** a client submits a product-fault report to the intake service
- **THEN** the submission SHALL be authenticated by a submission-scoped credential
- **AND** the client SHALL NOT be required to hold a GitHub token or broad GitHub permission to submit

#### Scenario: client cannot create upstream issues

- **WHEN** a client submits a report
- **THEN** the client SHALL NOT itself create any upstream GitHub issue; only maintainer-side
  promotion (a separate capability) MAY do so

### Requirement: The intake service SHALL validate, rate-limit, and deduplicate submissions

The intake service SHALL reject payloads that are malformed, oversized, or of an unknown/unsupported
`payload_schema_version`. It SHALL rate-limit submissions per source to bound abuse, and it SHALL
deduplicate reports by their stable `fingerprint` so that repeated occurrences of the same defect
accumulate against one cluster rather than creating unbounded distinct records.

#### Scenario: malformed or unknown-schema payloads are rejected

- **WHEN** a submission is malformed, exceeds the size bound, or declares an unsupported
  `payload_schema_version`
- **THEN** the intake service SHALL reject it and SHALL NOT store it as a valid report

#### Scenario: submissions are rate-limited per source

- **WHEN** a single source exceeds the configured submission rate
- **THEN** the intake service SHALL reject or throttle the excess submissions

#### Scenario: identical fingerprints deduplicate into one cluster

- **WHEN** multiple valid submissions share the same stable `fingerprint`
- **THEN** the intake service SHALL accumulate them against a single fingerprint cluster with an
  anonymous count rather than creating unbounded distinct records

### Requirement: The intake service SHALL enforce a retention and deletion policy

The intake service SHALL retain only the minimum data necessary to fingerprint, cluster,
deduplicate, and rate-limit, and SHALL support enforcement of a retention window and deletion
requests. Data beyond the retention window SHALL be purged.

#### Scenario: retention window is enforced

- **WHEN** stored report data ages beyond the configured retention window
- **THEN** it SHALL be purged from the intake service

#### Scenario: deletion is supported

- **WHEN** a deletion request is issued against stored report data
- **THEN** the intake service SHALL support removing the corresponding data
