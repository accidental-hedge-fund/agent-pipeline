# fleet-reporting Specification

## Purpose
TBD - created by archiving change fleet-telemetry-aggregation. Update Purpose after archive.
## Requirements
### Requirement: Fleet reporting is read-only and aggregates existing metrics across repos and hosts

The pipeline SHALL provide a read-only fleet report that aggregates the existing `scoreboard` and
`improve` metrics across authorized repositories and hosts from the collected fleet telemetry. The
report SHALL be retrieved via the authenticated `POST /fleet/v1/query` endpoint defined by the
`fleet-collector-contract` capability (`design.md` D11), authenticating with a scoped query credential
rather than reading collector storage directly. The report SHALL be available in both human-readable and
JSON form, and SHALL NOT mutate GitHub labels/comments, worktrees, pipeline configuration, or any run
artifact — mirroring the read-only contract of the local `scoreboard` and `improve` commands.

#### Scenario: fleet report aggregates existing scoreboard metrics

- **WHEN** a fleet report is generated over fleet telemetry from multiple repositories and hosts
- **THEN** it SHALL include the existing scoreboard metrics aggregated across those repositories and
  hosts

#### Scenario: fleet report is read-only

- **WHEN** a fleet report is generated
- **THEN** it SHALL NOT mutate GitHub labels/comments, worktrees, pipeline configuration, or any run
  artifact

#### Scenario: fleet report is available as human and JSON output

- **WHEN** a fleet report is requested in JSON form
- **THEN** it SHALL emit a machine-readable JSON report equivalent in content to the human-readable form

### Requirement: Fleet reports filter and group by fleet dimensions

Fleet reports SHALL support filtering and grouping by pseudonymous repository, installation, host,
Pipeline version, stage, harness/model, outcome, and time window.

#### Scenario: report groups by a chosen dimension

- **WHEN** a fleet report is generated grouped by host
- **THEN** its metrics SHALL be broken down per pseudonymous host

#### Scenario: report filters by time window and installation

- **WHEN** a fleet report is generated for a given time window and installation
- **THEN** only telemetry from that installation within that window SHALL contribute to the report

### Requirement: Fleet reports include required fleet-level contents

A fleet report SHALL include, in addition to the existing scoreboard metrics: run counts, active and
stale installation counts, delivery health, and top blocker/failure classes. When correction evidence
from #499–#501 (`correction_event` records) is present in the telemetry, the report SHALL additionally
include correction recurrence; when that evidence is absent, correction recurrence MAY be omitted.

#### Scenario: report includes run counts, installation health, delivery health, and blockers

- **WHEN** a fleet report is generated
- **THEN** it SHALL include run counts, active/stale installation counts, delivery health, and top
  blocker/failure classes

#### Scenario: correction recurrence appears only when its evidence is present

- **WHEN** a fleet report is generated over telemetry that includes `correction_event` records
- **THEN** the report SHALL include correction recurrence
- **AND** when no such records are present the report MAY omit correction recurrence without error

### Requirement: Fleet reports preserve evidence lineage

Every aggregated metric in a fleet report SHALL preserve evidence lineage back to the contributing
runs and events, so an operator can trace any reported number to its source telemetry.

#### Scenario: a metric traces to its source runs

- **WHEN** a fleet report presents an aggregated metric
- **THEN** it SHALL be possible to trace that metric to the contributing runs and events

### Requirement: Pseudonymous repository mapping stays customer-local

Fleet reports SHALL resolve a pseudonymous `repo_id` to a friendly name only from customer-controlled
local metadata or customer-controlled collector metadata, and this mapping SHALL NEVER be transmitted
to Agent Pipeline maintainers through this feature.

#### Scenario: friendly names are resolved locally

- **WHEN** a fleet report displays a friendly repository name
- **THEN** the name SHALL be resolved from customer-controlled local or collector metadata
- **AND** the pseudonymous-to-friendly mapping SHALL NOT be transmitted to Agent Pipeline maintainers

