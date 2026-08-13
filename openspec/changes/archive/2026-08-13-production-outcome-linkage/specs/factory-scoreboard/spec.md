## ADDED Requirements

### Requirement: Factory scoreboard SHALL report production outcomes by kind and observation state without a collapsed score

When the local outcome store contains `production_outcome` records in the scoreboard window (by `signal_at` or `observed_at` under a documented priority), `pipeline scoreboard` SHALL include an additive `outcomes` section in human and JSON output. The section SHALL report at minimum:

- counts by `outcome_kind` for each closed kind present or zero for known kinds
- counts by `observation_state`
- count of outcomes with at least one `authority: "observed"` attribution vs only `inferred` attributions

The scoreboard SHALL NOT emit a single maintainability or production-quality score that collapses all outcome kinds. Missing outcome store SHALL yield zero counts and an optional diagnostic, not a crash. The command remains read-only toward GitHub and run artifacts; it MAY read the outcome store without mutating it.

#### Scenario: JSON exposes outcomes section with kind counts

- **WHEN** the window includes two `reversion` outcomes and one `delivery` outcome in the outcome store
- **AND** `pipeline scoreboard --json` is invoked
- **THEN** the parsed JSON SHALL contain an `outcomes` object
- **AND** kind counts SHALL reflect two reversions and one delivery
- **AND** no `maintainability_score` field SHALL be required by this capability

#### Scenario: observation_state counts appear

- **WHEN** included outcomes include one `observed` and one `delayed` record
- **THEN** the outcomes section SHALL report counts that distinguish those states

#### Scenario: missing outcome store is empty not fatal

- **WHEN** no outcome store directory exists
- **AND** `pipeline scoreboard --json` is invoked
- **THEN** stdout SHALL remain a valid scoreboard JSON object
- **AND** outcome counts SHALL be zero or the section absent with a diagnostic code such as `missing_outcome_store`

---

### Requirement: Scoreboard outcome reporting SHALL separate observed facts from inferred attribution

Within the scoreboard `outcomes` section (JSON and human), reporting SHALL distinguish **observed outcome records / observed attributions** from **inferred attributions**. Inferred run or component links SHALL NOT be presented as proven delivery success or failure of a specific pipeline run. When both authorities exist on the same outcome, both SHALL be visible with labels or separate fields.

#### Scenario: inferred-only linkage is labeled

- **WHEN** an included `escaped_defect` outcome has only `authority: "inferred"` run attributions
- **THEN** scoreboard output SHALL mark that linkage as inferred (or place it under an inferred partition)
- **AND** SHALL NOT list that run under an “observed failures” total reserved for observed authority

#### Scenario: observed delivery merge is not auto-deploy success

- **WHEN** a `delivery` outcome has `merge_status: "merged"` and `deploy_status: "not_observed"`
- **THEN** scoreboard outcome reporting SHALL NOT count that record as a successful production deployment
- **AND** deploy not-observed SHALL remain visible in status breakdowns when status counts are shown
