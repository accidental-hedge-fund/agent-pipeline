## ADDED Requirements

### Requirement: Scoreboard SHALL report Tester metrics from structured fields

The factory scoreboard SHALL be able to report Tester duration, command count,
and pass/fail/timeout/tooling (or other `overall_status`) outcomes from
structured fields when included runs contain well-formed `TesterEvidence`
records (or equivalent structured Tester events in the run surfaces). When
supplemental targeted-check records exist, the scoreboard MAY report their
count or cost as redundant targeted-check diagnostics. The scoreboard SHALL NOT
require parsing human-readable Tester summary comments to obtain these metrics.
Runs without Tester artifacts SHALL remain valid scoreboard inputs with Tester
metrics absent or diagnosed as missing.

#### Scenario: passed Tester run contributes structured metrics

- **WHEN** a run in the scoreboard window has `TesterEvidence` with
  `overall_status: "passed"`, `duration_ms` set, and a non-empty `commands`
  array
- **THEN** the scoreboard SHALL be able to include that duration and a pass
  outcome from structured fields
- **AND** SHALL NOT need to parse a PR comment body for those values

#### Scenario: failed and tooling outcomes remain distinguishable

- **WHEN** included runs have Tester evidence with `overall_status` values
  `"failed"` and `"tooling_failure"`
- **THEN** scoreboard aggregations or diagnostics SHALL be able to distinguish
  those classes from structured status fields

#### Scenario: targeted-check cost is optional structured diagnostic

- **WHEN** a run records supplemental targeted-check results alongside
  authoritative Tester evidence
- **THEN** the scoreboard MAY report targeted-check count or cost from
  structured fields as a redundant-check diagnostic
- **AND** SHALL NOT treat a targeted-check pass as a suite pass metric in place
  of `TesterEvidence.overall_status`

#### Scenario: runs without Tester evidence remain scorable

- **WHEN** an included run has no `TesterEvidence` artifact
- **THEN** the run SHALL still contribute to non-Tester scoreboard metrics
- **AND** Tester-specific metrics for that run SHALL be omitted or marked
  missing rather than inferred as passed
