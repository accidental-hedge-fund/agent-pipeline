## ADDED Requirements

### Requirement: Retention is customer-configured and enforced

The collector SHALL enforce a customer-configured retention window for stored fleet telemetry, and
telemetry older than the window SHALL be expired or dropped. Retention behavior SHALL be documented and
testable.

#### Scenario: out-of-window telemetry is expired

- **WHEN** telemetry older than the configured retention window is present
- **THEN** the collector SHALL expire or drop it so it no longer appears in reports

### Requirement: Tenant and installation data can be deleted

The collector SHALL support deletion of a tenant's or installation's stored telemetry, and deleted
telemetry SHALL no longer appear in queries or reports. Deletion behavior SHALL be documented and
testable.

#### Scenario: deleted data disappears from queries

- **WHEN** a tenant's stored telemetry is deleted
- **THEN** subsequent queries and reports SHALL NOT return the deleted telemetry

### Requirement: Telemetry can be exported to customer-owned storage

The collector SHALL support exporting a tenant's stored telemetry as a customer-owned dump so the
customer retains full control of their data. Export behavior SHALL be documented and testable.

#### Scenario: export produces a customer-owned dump

- **WHEN** a tenant requests an export of its telemetry
- **THEN** the collector SHALL produce a customer-owned dump of that tenant's telemetry

### Requirement: Access to telemetry is auditable

The collector SHALL record an access-audit entry for ingest, query, and credential operations, so a
customer can review who accessed telemetry and when. The audit behavior SHALL be documented and
testable.

#### Scenario: an access-audit entry is recorded

- **WHEN** a query or credential operation is performed against the collector
- **THEN** the collector SHALL record an access-audit entry for that operation

### Requirement: Ingest credentials rotate and revoke without repository-config changes

The collector SHALL support rotation and revocation of scoped ingest credentials without requiring any
repository-configuration change, and a revoked credential SHALL be refused for both write and query.
Rotation behavior SHALL be documented and testable.

#### Scenario: revoked credential is refused

- **WHEN** a scoped ingest credential is revoked
- **THEN** the collector SHALL refuse subsequent writes and queries presenting that credential
- **AND** the revocation SHALL require no repository-configuration change
