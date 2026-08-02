## ADDED Requirements

### Requirement: Status JSON SHALL include event-stream write-health when available

The JSON object produced by `pipeline <issue> --status --json` SHALL include an additive field
describing event-stream write-health for the issue's latest (or active) run when that run's
write-health is readable. When write-health recorded failures, the field SHALL be a non-null object
carrying enough detail for an operator or automation to see that the event stream failed mid-run
(at minimum: failure indication, worst criticality when known, and last error or last failed event
type when known). When write-health is healthy or the run has no write-health file from a pre-change
engine, the field SHALL be `null` or an explicit healthy representation without requiring a
`schema_version` bump. The envelope `schema_version` SHALL remain `"1"`, and every other minimum
status field SHALL continue to be present.

#### Scenario: Elevated write-health appears in status JSON

- **WHEN** `pipeline <issue> --status --json` is invoked
- **AND** the latest run directory has write-health recording one or more append failures
- **THEN** the JSON envelope SHALL include a non-null write-health (or equivalent) object
- **AND** that object SHALL indicate failure and worst criticality when known
- **AND** `schema_version` SHALL equal `"1"`

#### Scenario: Healthy or absent write-health does not look failed

- **WHEN** `pipeline <issue> --status --json` is invoked
- **AND** the latest run has zero recorded append failures or no write-health artifact from a
  legacy run
- **THEN** the write-health field SHALL be `null` or an explicit healthy representation
- **AND** the command SHALL NOT invent a write-health failure

### Requirement: Status prose SHALL warn when event-stream write-health is elevated

The prose status output of `pipeline <issue> --status` (without `--json`) SHALL include a clear
warning that the run event stream experienced write failure and that evidence may be incomplete when
the latest run has elevated write-health (one or more recorded append failures). When write-health
is healthy or absent, status prose SHALL NOT emit that warning.

#### Scenario: Prose status warns on elevated write-health

- **WHEN** `pipeline <issue> --status` runs for an issue whose latest run has elevated write-health
- **THEN** stdout SHALL include a human-readable warning about event-stream write failure

#### Scenario: Prose status stays quiet when healthy

- **WHEN** `pipeline <issue> --status` runs for an issue whose latest run has healthy or absent
  write-health
- **THEN** stdout SHALL NOT claim an event-stream write failure for that run
