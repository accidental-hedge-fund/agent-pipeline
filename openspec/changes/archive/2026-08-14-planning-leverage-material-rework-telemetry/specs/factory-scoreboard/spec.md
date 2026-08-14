## ADDED Requirements

### Requirement: Factory scoreboard SHALL report planning-leverage and material-rework aggregates without a collapsed productivity score

When included runs contain planning-leverage family events or snapshots, `pipeline scoreboard` SHALL include an additive `planning_leverage` section in human and JSON output. The section SHALL report at minimum:

- counts of runs by `planning_depth` and by `risk_class` (including `unknown`)
- phase elapsed totals or per-phase elapsed sums when elapsed is observed; unavailable elapsed SHALL NOT be coerced to zero without an unavailable label
- assumption lineage counts: open/deferred vs resolved (from latest status per `assumption_id` per run)
- material vs ordinary vs unknown rework counts and fix-round distributions when material-rework events exist
- explicit partition or labels distinguishing **observed raw fields**, **derived metrics**, and **unavailable** values

The scoreboard SHALL NOT emit a single productivity, leverage, or expected-pain score that collapses these dimensions. Runs with no planning-leverage telemetry SHALL contribute zeros for these counters and MAY add diagnostic code `telemetry_absent` (or equivalent), and SHALL NOT crash the scoreboard. The command remains read-only toward GitHub and run artifacts.

#### Scenario: JSON exposes planning_leverage section

- **WHEN** the window includes runs with `planning_leverage_phase` and `material_rework` events
- **AND** `pipeline scoreboard --json` is invoked
- **THEN** the parsed JSON SHALL contain a `planning_leverage` object
- **AND** the object SHALL include depth and materiality breakdowns
- **AND** no `productivity_score`, `leverage_score`, or `expected_pain` field SHALL be required by this capability

#### Scenario: missing telemetry is empty not fatal

- **WHEN** included runs have no planning-leverage family events
- **AND** `pipeline scoreboard --json` is invoked
- **THEN** stdout SHALL remain a valid scoreboard JSON object
- **AND** planning-leverage counts SHALL be zero or the section present with a `telemetry_absent` (or equivalent) diagnostic

#### Scenario: unavailable active effort is not reported as zero cost fact

- **WHEN** runs have phase elapsed observed but active effort unavailable
- **THEN** the planning_leverage section SHALL NOT present active effort as `0` without an unavailable or missing label
- **AND** derived metrics that require active effort SHALL be marked unavailable or omitted with a diagnostic

---

### Requirement: Scoreboard planning-leverage reporting SHALL separate observed fields from derived and inferred values

Within the scoreboard `planning_leverage` section (JSON and human), reporting SHALL distinguish **observed raw telemetry** (phase timestamps, selected depth/risk, materiality classifications, assumption statuses) from **derived metrics** (ratios, rollups) and from **inferred** claims. Inferred values SHALL NOT be presented as observed facts. When both exist, both SHALL be visible with labels or separate fields.

#### Scenario: derived ratio is labeled derived

- **WHEN** the section includes a ratio of correction elapsed to planning elapsed
- **THEN** scoreboard output SHALL place that ratio under a derived partition or label
- **AND** SHALL NOT list it as a raw phase field

#### Scenario: inferred depth estimate does not overwrite selected depth counts

- **WHEN** a run records `planning_depth: "unknown"` and a derived estimate suggests `minimal`
- **THEN** depth histogram counts keyed as selected depth SHALL attribute the run to `unknown`
- **AND** any estimated depth SHALL appear only under derived/inferred reporting if shown
