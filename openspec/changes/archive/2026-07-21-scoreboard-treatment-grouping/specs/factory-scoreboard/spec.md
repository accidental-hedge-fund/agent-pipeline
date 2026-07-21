## ADDED Requirements

### Requirement: Factory scoreboard supports an optional single execution-identity grouping dimension

The `pipeline scoreboard` command SHALL accept an optional `--by <dimension>` flag whose
only supported values are `harness`, `model`, `effort`, and `executor`. Exactly one
dimension SHALL be accepted per invocation.

When `--by` is supplied, the report SHALL include an additive grouping result naming the
selected dimension and containing one entry per distinct identity value observed across
the window's `stage_accounting` records, in addition to every existing report section.

When `--by` is supplied with any value other than the four supported dimensions, the
command SHALL fail with an error message naming all four supported values, SHALL exit
non-zero, and SHALL NOT write any report output to stdout. When `--by` is supplied more
than once in a single invocation, the command SHALL fail with an error stating that
exactly one dimension is supported, SHALL exit non-zero, and SHALL NOT write any report
output to stdout. Both validations SHALL occur before any run artifact is read.

When `--by` is omitted, the command SHALL behave exactly as before: no grouping SHALL be
computed, no grouping-related key SHALL appear in JSON output, and no grouping section
SHALL appear in human output.

#### Scenario: grouping by harness produces one entry per recorded harness
- **WHEN** `pipeline scoreboard --by harness --json` is invoked over a window whose accounting records name two distinct harnesses
- **THEN** the report SHALL contain a grouping result whose dimension is `harness`
- **AND** its groups SHALL contain exactly one entry per distinct recorded harness value
- **AND** each entry's key SHALL be the recorded harness value verbatim

#### Scenario: each supported dimension uses the same entry shape
- **WHEN** `pipeline scoreboard --by model --json`, `--by effort --json`, and `--by executor --json` are invoked over the same window
- **THEN** each report SHALL contain a grouping result naming the requested dimension
- **AND** every group entry in every one of those reports SHALL expose the same set of metric keys

#### Scenario: an unsupported dimension fails without partial output
- **WHEN** `pipeline scoreboard --by team --json` is invoked
- **THEN** the command SHALL exit with a non-zero status
- **AND** stderr SHALL name `harness`, `model`, `effort`, and `executor` as the supported values
- **AND** stdout SHALL contain no scoreboard report

#### Scenario: a repeated grouping flag is rejected
- **WHEN** `pipeline scoreboard --by harness --by model --json` is invoked
- **THEN** the command SHALL exit with a non-zero status
- **AND** stderr SHALL state that exactly one grouping dimension is supported
- **AND** stdout SHALL contain no scoreboard report

#### Scenario: omitting the grouping flag leaves output unchanged
- **WHEN** `pipeline scoreboard --json` is invoked without `--by` against a repository with run artifacts
- **THEN** the parsed JSON object SHALL NOT contain a grouping key
- **AND** it SHALL NOT contain a grouping-dimension key
- **AND** the human-readable report for the same invocation SHALL NOT contain a grouping section

### Requirement: Grouped entries reuse the existing record-scoped metrics and conserve window totals

Each group entry SHALL expose the record-scoped metrics the report already computes for
`cost_accounting` — invocation count, total duration, command count, subprocess count,
prompt-size totals, and accumulated actual, estimated, and unknown cost — computed only
from the accounting records assigned to that group.

Grouping SHALL NOT split run-scoped metrics. Metrics whose unit of observation is a whole
run or a pull request — including the autonomy rate, full-run duration, blocker rates,
needs-human rate, gate pass rates, and the per-pull-request rates — SHALL remain
window-level and SHALL be unaffected by `--by`, because a single run may span multiple
harnesses, models, and executors and its outcome cannot be attributed to any one of them.

Every accounting record that the report already counts SHALL contribute to exactly one
group. The sum of `invocation_count` across all groups SHALL equal the window's
`cost_accounting.totals.invocation_count`, and the summed per-group actual and estimated
cost SHALL equal the corresponding window totals. Grouping SHALL NOT change any existing
metric definition and SHALL NOT alter the values of any existing report key.

Group ordering SHALL be deterministic for a given set of artifacts: groups SHALL be
ordered by descending invocation count, with ties broken by ascending group key.

#### Scenario: group sums conserve the window totals
- **WHEN** `pipeline scoreboard --by model --json` is invoked over a window containing accounting records for several models
- **THEN** the sum of `invocation_count` across all groups SHALL equal `cost_accounting.totals.invocation_count`
- **AND** the summed per-group actual cost SHALL equal `cost_accounting.totals.actual_cost_usd`
- **AND** the summed per-group estimated cost SHALL equal `cost_accounting.totals.estimated_cost_usd`

#### Scenario: run-scoped metrics are not split by the grouping dimension
- **WHEN** `pipeline scoreboard --by harness --json` is invoked
- **THEN** the top-level `metrics` object SHALL contain the same keys and values it contains without `--by` for the same window and artifacts
- **AND** no group entry SHALL report an autonomy rate, a full-run duration, or a gate pass rate

#### Scenario: group ordering is deterministic
- **WHEN** `pipeline scoreboard --by harness --json` is invoked twice over the same unchanged run artifacts
- **THEN** the two reports' group entries SHALL appear in the same order
- **AND** that order SHALL be descending by invocation count with ties broken by ascending group key

### Requirement: Grouping identities are reported verbatim with explicit unknown and not-applicable groups

A group key SHALL be the recorded identity value used verbatim, without case folding,
aliasing, or any other normalization. Two distinct recorded spellings SHALL therefore
produce two distinct groups.

A record whose selected identity field is absent or empty SHALL be assigned to a group
whose key is exactly `unknown`. A record for which the selected dimension cannot apply
SHALL be assigned to a group whose key is exactly `not applicable`. The `unknown` and
`not applicable` groups SHALL be distinct from each other and from every recorded identity
value, SHALL NOT be merged, and SHALL NOT be omitted from the report when non-empty. No
record SHALL be silently dropped in order to avoid emitting either group.

The `harness` and `executor` dimensions SHALL remain distinct identities over distinct
recorded fields. The `harness` dimension SHALL group on the record's harness field
verbatim, which for a delegated stage is the configured executor name. The `executor`
dimension SHALL group on the record's executor provider, SHALL report the executor model
values observed within a group as a detail, and SHALL assign every record carrying no
executor evidence to `not applicable`. A delegated record that carries executor evidence
but no recorded provider SHALL be assigned to `unknown`.

Cost provenance SHALL be preserved per group: each entry SHALL report its actual,
estimated, and unknown call counts alongside its cost sums, and SHALL report an actual
coverage ratio that is `null` when the group has no calls, matching this capability's
existing zero-denominator rule.

#### Scenario: a missing identity groups as unknown rather than being coerced
- **WHEN** `pipeline scoreboard --by model --json` is invoked over a window in which some accounting records carry no model value
- **THEN** those records SHALL be counted in a group whose key is exactly `unknown`
- **AND** they SHALL NOT be added to any group named after a recorded model
- **AND** they SHALL NOT be excluded from the grouping result

#### Scenario: unknown and not applicable are distinct executor groups
- **WHEN** `pipeline scoreboard --by executor --json` is invoked over a window containing a record with no executor evidence and a delegated record whose executor provider was not recorded
- **THEN** the report SHALL contain a group whose key is exactly `not applicable` counting the first record
- **AND** it SHALL contain a separate group whose key is exactly `unknown` counting the second record
- **AND** the two groups SHALL NOT be merged

#### Scenario: harness and executor identities are not conflated
- **WHEN** a run delegated one stage to an external executor and `pipeline scoreboard --json` is invoked once with `--by harness` and once with `--by executor` over that window
- **THEN** the `--by harness` report SHALL count that record under its recorded harness value
- **AND** the `--by executor` report SHALL count that record under its recorded executor provider value
- **AND** neither report SHALL count it under the other dimension's value

#### Scenario: cost provenance is preserved within each group
- **WHEN** `pipeline scoreboard --by harness --json` is invoked over a window containing records with actual, estimated, and unknown cost sources
- **THEN** each group SHALL report its own actual, estimated, and unknown call counts
- **AND** each group's actual coverage SHALL be the ratio of its actual calls to its total calls
- **AND** a group with no calls SHALL report an actual coverage of `null` rather than `0`

### Requirement: Grouped output is emitted in both human and JSON form and composes with time buckets

When `--by` is supplied with `--json`, the command SHALL write exactly one unfenced JSON
object containing an additive top-level key holding the selected dimension and an additive
top-level key holding the ordered array of group entries. These keys SHALL be additive: the
report's `schema_version` SHALL remain unchanged and all pre-existing keys SHALL retain
their meaning and values.

When `--by` is supplied without `--json`, the human-readable report SHALL render the same
groups as a labelled section after the existing summary, one line-group per identity, in
the same order as the JSON groups, including the `unknown` and `not applicable` groups.

When `--by` is supplied together with `--bucket`, each series entry SHALL additionally carry
its own grouping result computed only from that period's runs, using the same entry shape
and the same identity rules. Each period's group invocation counts SHALL sum to that
period's `cost_accounting.totals.invocation_count`.

#### Scenario: JSON output carries a parseable grouping result
- **WHEN** `pipeline scoreboard --by harness --json` is invoked
- **THEN** stdout SHALL contain exactly one JSON object and `JSON.parse(stdout)` SHALL succeed
- **AND** the parsed object SHALL report the selected dimension as `harness` and an array of group entries
- **AND** the report's `schema_version` SHALL be unchanged from a report produced without `--by`

#### Scenario: human output renders the same groups
- **WHEN** `pipeline scoreboard --by executor` is invoked without `--json` over a window containing both delegated and local-harness records
- **THEN** stdout SHALL include the existing summary sections unchanged
- **AND** stdout SHALL include a grouping section with one labelled line-group per identity, in the same order as the JSON groups
- **AND** that section SHALL include the `not applicable` group

#### Scenario: grouping composes with day buckets
- **WHEN** `pipeline scoreboard --by harness --bucket day --json` is invoked over a multi-day window
- **THEN** every series entry SHALL carry its own grouping result for the `harness` dimension
- **AND** each entry's group invocation counts SHALL sum to that entry's `cost_accounting.totals.invocation_count`
- **AND** the top-level grouping result SHALL remain the full-window aggregate
