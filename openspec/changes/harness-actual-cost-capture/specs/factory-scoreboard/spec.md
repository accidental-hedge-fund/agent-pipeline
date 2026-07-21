# factory-scoreboard Spec Delta

## ADDED Requirements

### Requirement: Factory scoreboard reports cost-source coverage

The `pipeline scoreboard` command SHALL report cost-source coverage across the
accounting records included in the window, so maintainers can judge how much of the
reported cost is measured rather than guessed. Coverage SHALL expose the number of
recorded harness calls whose `cost_source` is `actual`, the number that are
`estimated`, the number that are `unknown`, and an `actual_coverage` ratio equal to the
actual call count divided by the total included call count.

Consistent with this capability's existing zero-denominator rule, `actual_coverage`
SHALL be `null` rather than `0` when no calls are included. Coverage SHALL be reported
in both the human-readable report and the `--json` object, and SHALL NOT change the
existing cost totals, `cost_per_ready_pr_usd`, `--estimate-cost` syntax, or estimate
precedence.

#### Scenario: JSON output exposes coverage counts and ratio
- **WHEN** `pipeline scoreboard --json` includes four harness calls whose `cost_source`
  values are `actual`, `actual`, `estimated`, and `unknown`
- **THEN** the parsed JSON SHALL report an actual call count of `2`, an estimated call
  count of `1`, and an unknown call count of `1`
- **AND** it SHALL report an `actual_coverage` value of `0.5`

#### Scenario: Human report prints the coverage line
- **WHEN** `pipeline scoreboard` prints its cost/accounting section for a window
  containing accounting records
- **THEN** stdout SHALL include a coverage entry naming the actual, estimated, and
  unknown call counts
- **AND** it SHALL include the actual-coverage ratio

#### Scenario: Empty window reports null coverage
- **WHEN** `pipeline scoreboard --json` is invoked for a window containing no accounting
  records
- **THEN** the reported actual, estimated, and unknown call counts SHALL each be `0`
- **AND** `actual_coverage` SHALL be `null`

#### Scenario: Coverage does not alter cost totals or estimate precedence
- **WHEN** an included successful PR has one call with an actual cost and one call
  covered by a supplied `--estimate-cost` value
- **THEN** the actual cost SHALL still take precedence over an estimate for the same
  call
- **AND** `cost_per_ready_pr_usd` SHALL be computed exactly as it was before coverage
  reporting was added
