# product-fault-issue-promotion Specification

## Purpose
TBD - created by archiving change product-fault-reporting. Update Purpose after archive.
## Requirements
### Requirement: Cluster promotion SHALL be gated on high-confidence crash or cross-installation recurrence

The maintainer-side promotion process SHALL promote a fingerprint cluster to a GitHub issue only
when the cluster reflects either a high-confidence crash or a fingerprint repeated across multiple
installations. Clusters below the promotion threshold SHALL NOT be promoted and SHALL remain as
intake-side aggregate data only.

#### Scenario: high-confidence crash promotes

- **WHEN** a fingerprint cluster reflects a high-confidence crash
- **THEN** the promotion process SHALL be eligible to open or update a GitHub issue for that cluster

#### Scenario: cross-installation recurrence promotes

- **WHEN** a fingerprint is reported across multiple distinct installations above the recurrence
  threshold
- **THEN** the promotion process SHALL be eligible to open or update a GitHub issue for that cluster

#### Scenario: below-threshold clusters are not promoted

- **WHEN** a cluster is neither a high-confidence crash nor above the cross-installation recurrence
  threshold
- **THEN** no GitHub issue SHALL be created or updated for it

### Requirement: Promotion SHALL maintain exactly one GitHub issue per stable fingerprint with sanitized aggregate evidence only

When a cluster is promoted, a maintainer bot SHALL open or update exactly **one** GitHub issue per
stable `fingerprint`. The issue body SHALL contain only sanitized aggregate evidence: affected
Agent Pipeline versions, host adapters, stage, error class/fingerprint, and anonymous report counts.
Client-submitted free text, repository identity, paths, and any non-allowlisted data SHALL NOT
appear in the issue. A subsequent promotion of the same fingerprint SHALL update the existing issue
rather than open a duplicate.

#### Scenario: one issue per fingerprint

- **WHEN** a fingerprint cluster is promoted and no open issue exists for that fingerprint
- **THEN** the bot SHALL open exactly one GitHub issue keyed to that fingerprint

#### Scenario: repeat promotion updates rather than duplicates

- **WHEN** a fingerprint that already has an open promoted issue crosses the threshold again
- **THEN** the bot SHALL update the existing issue (e.g. affected versions and counts) rather than
  open a second issue

#### Scenario: issue carries only sanitized aggregate evidence

- **WHEN** a promoted issue is created or updated
- **THEN** its body SHALL contain only affected versions, host adapters, stage, error
  class/fingerprint, and anonymous report counts
- **AND** SHALL NOT contain client-submitted free text, repository identity, paths, or any
  non-allowlisted data

