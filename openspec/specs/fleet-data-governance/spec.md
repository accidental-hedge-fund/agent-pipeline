# fleet-data-governance Specification

## Purpose
TBD - created by archiving change fleet-telemetry-aggregation. Update Purpose after archive.
## Requirements
### Requirement: Retention is customer-configured and enforced

The collector SHALL enforce a customer-configured retention window for stored fleet telemetry, and
telemetry older than the window SHALL be expired or dropped. Retention behavior SHALL be documented and
testable.

#### Scenario: out-of-window telemetry is expired

- **WHEN** telemetry older than the configured retention window is present
- **THEN** the collector SHALL expire or drop it so it no longer appears in reports

### Requirement: Tenant and installation data can be deleted only by a tenant-scoped privileged credential

The collector SHALL support deletion of a tenant's or installation's stored telemetry, and deleted
telemetry SHALL no longer appear in queries or reports. Deletion behavior SHALL be documented and
testable. Deletion SHALL require a privileged credential explicitly bound to the target tenant (distinct
from an ordinary scoped ingest/query credential), and the collector SHALL refuse a deletion request
whose credential scope does not match the requested tenant/installation, recording an audit entry for
both accepted and refused attempts.

#### Scenario: deleted data disappears from queries

- **WHEN** a tenant's stored telemetry is deleted using a privileged credential scoped to that tenant
- **THEN** subsequent queries and reports SHALL NOT return the deleted telemetry

#### Scenario: cross-tenant deletion is refused

- **WHEN** a privileged deletion credential scoped to tenant A attempts to delete tenant B's data
- **THEN** the collector SHALL refuse the deletion
- **AND** it SHALL record an audit entry for the refused attempt

### Requirement: Telemetry can be exported to customer-owned storage only within the caller's tenant scope

The collector SHALL support exporting a tenant's stored telemetry as a customer-owned dump so the
customer retains full control of their data. Export behavior SHALL be documented and testable. An export
request SHALL authenticate with a scoped query credential and SHALL be limited to that credential's
tenant scope; the collector SHALL refuse an export request for a tenant outside the caller's scope and
SHALL record an audit entry for both accepted and refused attempts.

#### Scenario: export produces a customer-owned dump

- **WHEN** a tenant requests an export of its telemetry using a credential scoped to that tenant
- **THEN** the collector SHALL produce a customer-owned dump of that tenant's telemetry

#### Scenario: cross-tenant export is refused

- **WHEN** a query credential scoped to tenant A attempts to export tenant B's telemetry
- **THEN** the collector SHALL refuse the export and SHALL NOT produce a dump of tenant B's data
- **AND** it SHALL record an audit entry for the refused attempt

### Requirement: Access to telemetry is auditable

The collector SHALL record an access-audit entry for ingest, query, deletion, export, and credential
operations — including the scoped principal and outcome (accepted or refused) — so a customer can review
who accessed telemetry and when. The audit behavior SHALL be documented and testable.

#### Scenario: an access-audit entry is recorded

- **WHEN** a query, deletion, export, or credential operation is performed against the collector
- **THEN** the collector SHALL record an access-audit entry for that operation, including the scoped
  principal and outcome

### Requirement: Ingest credentials rotate and revoke without repository-config changes

The collector SHALL support rotation and revocation of scoped ingest credentials without requiring any
repository-configuration change, and a revoked credential SHALL be refused for both write and query.
Rotation behavior SHALL be documented and testable.

#### Scenario: revoked credential is refused

- **WHEN** a scoped ingest credential is revoked
- **THEN** the collector SHALL refuse subsequent writes and queries presenting that credential
- **AND** the revocation SHALL require no repository-configuration change

