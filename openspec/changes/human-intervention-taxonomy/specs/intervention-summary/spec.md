## ADDED Requirements

### Requirement: A pure helper aggregates human_intervention events by kind over a run window
The engine SHALL provide `summarizeInterventions(events: Event[], windowMs?: number): InterventionSummary` in `core/scripts/intervention.ts`. The helper SHALL:

- Accept the full `events.jsonl` event array for one or more runs.
- When `windowMs` is provided, filter to events whose `at` timestamp is within the last `windowMs` milliseconds of the most recent event's timestamp.
- Return an `InterventionSummary` object containing: `total` (integer count), `byKind` (a `Record<HumanInterventionKind, number>` with zero-initialized entries for all known kinds), and `items` (array of the raw `human_intervention` event objects in chronological order).

The helper SHALL be a total function: an empty event array or a window that matches no events SHALL return a valid summary with `total: 0` and all `byKind` entries at zero.

#### Scenario: aggregation counts each kind correctly
- **WHEN** `summarizeInterventions` is called with events containing three `human_intervention` events of kinds `"review-non-convergence"`, `"review-non-convergence"`, and `"test-build-failure"`
- **THEN** `total` SHALL be `3`
- **AND** `byKind["review-non-convergence"]` SHALL be `2`
- **AND** `byKind["test-build-failure"]` SHALL be `1`
- **AND** all other `byKind` entries SHALL be `0`

#### Scenario: window filter excludes events outside the window
- **WHEN** `summarizeInterventions` is called with a `windowMs` value
- **THEN** only `human_intervention` events whose `at` is within the window SHALL be counted
- **AND** events outside the window SHALL not appear in `total`, `byKind`, or `items`

#### Scenario: empty event list returns zero summary
- **WHEN** `summarizeInterventions` is called with an empty array
- **THEN** `total` SHALL be `0`
- **AND** every `byKind` entry SHALL be `0`
- **AND** `items` SHALL be an empty array

#### Scenario: unrecognized kind strings are counted under "unknown"
- **WHEN** an event has a `kind` value not present in the current taxonomy enum
- **THEN** it SHALL be counted under `byKind["unknown"]`
- **AND** the raw event SHALL still appear in `items` with its original `kind` preserved

### Requirement: improve --interventions prints an intervention summary
The `improve` subcommand SHALL accept an `--interventions` flag. When supplied, it SHALL read `events.jsonl` for the configured run window, call `summarizeInterventions`, and print the result as JSON to stdout. The output SHALL be machine-readable and SHALL NOT include additional prose.

#### Scenario: improve --interventions outputs valid JSON summary
- **WHEN** `improve --interventions` is invoked and run artifacts exist
- **THEN** stdout SHALL be a valid JSON object with `total`, `byKind`, and `items` fields
- **AND** exit code SHALL be `0`
- **AND** no additional prose SHALL appear on stdout

#### Scenario: improve --interventions with no run artifacts exits cleanly
- **WHEN** `improve --interventions` is invoked but no `events.jsonl` files are found
- **THEN** stdout SHALL be a valid JSON summary with `total: 0`
- **AND** exit code SHALL be `0`
