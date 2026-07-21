## ADDED Requirements

### Requirement: Factory scoreboard supports an optional day/week time-series bucket

The `pipeline scoreboard` command SHALL accept an optional `--bucket <unit>` flag whose
only supported values are `day` and `week`. When `--bucket` is supplied, the report SHALL
include a chronological series of per-period aggregates covering the selected window, in
addition to the existing full-window summary.

Period boundaries SHALL be computed in UTC and SHALL NOT be configurable. A `day` period
SHALL span one UTC calendar day, from `00:00:00.000Z` to the next `00:00:00.000Z`. A
`week` period SHALL span one ISO-8601 week, from Monday `00:00:00.000Z` to the next Monday
`00:00:00.000Z`.

Each period SHALL be a half-open interval `[start, end)` so that a run whose resolved
start timestamp falls exactly on a boundary belongs to the later period and is counted
exactly once. The first period's `start` SHALL be clamped to the window's `since` and the
final period's `end` SHALL be clamped to the window's `until`; the final period SHALL
additionally include a run whose resolved start timestamp equals `until`, matching the
window's inclusive upper bound. Series entries SHALL be ordered oldest-first, and each
entry's `end` SHALL equal the next entry's `start`.

A run SHALL be assigned to a period using the same resolved start timestamp that the
scanner already uses for window filtering, and the number of runs across all series
entries SHALL equal the window's `totals.included_runs`.

When `--bucket` is omitted, the command SHALL behave exactly as before: no series SHALL be
computed, no series-related key SHALL appear in JSON output, and no per-period section
SHALL appear in human output.

#### Scenario: day buckets align to UTC calendar days
- **WHEN** `pipeline scoreboard --since 2026-06-01T00:00:00Z --until 2026-06-04T00:00:00Z --bucket day --json` is invoked
- **THEN** the series SHALL contain three entries
- **AND** their `start` values SHALL be `2026-06-01T00:00:00.000Z`, `2026-06-02T00:00:00.000Z`, and `2026-06-03T00:00:00.000Z`
- **AND** each entry's `end` SHALL equal the next entry's `start`, with the final entry's `end` equal to `2026-06-04T00:00:00.000Z`

#### Scenario: week buckets align to ISO-8601 Mondays
- **WHEN** `pipeline scoreboard --since 2026-06-03T00:00:00Z --until 2026-06-17T00:00:00Z --bucket week --json` is invoked
- **AND** 2026-06-03 falls on a Wednesday
- **THEN** the first series entry's `start` SHALL be the window's `since` value and its `end` SHALL be the following Monday at `00:00:00.000Z`
- **AND** every interior entry SHALL start and end on a Monday at `00:00:00.000Z`
- **AND** the final entry's `end` SHALL equal the window's `until` value

#### Scenario: a run on a period boundary is counted once in the later period
- **WHEN** `pipeline scoreboard --bucket day --json` covers a window containing one included run whose resolved start timestamp is exactly `2026-06-02T00:00:00.000Z`
- **THEN** that run SHALL contribute to the period starting `2026-06-02T00:00:00.000Z`
- **AND** it SHALL NOT contribute to the period ending `2026-06-02T00:00:00.000Z`
- **AND** the sum of `totals.included_runs` across all series entries SHALL equal the window's `totals.included_runs`

#### Scenario: omitting the bucket flag leaves output unchanged
- **WHEN** `pipeline scoreboard --json` is invoked without `--bucket` against a repository with run artifacts
- **THEN** the parsed JSON object SHALL NOT contain a bucket key
- **AND** it SHALL NOT contain a series key
- **AND** the human-readable report for the same invocation SHALL NOT contain a per-period section

### Requirement: Bucketed periods reuse the existing scoreboard metrics and report empty periods explicitly

Each series entry SHALL expose `totals` and `metrics` using the same shapes the full-window
report already emits, computed only from the included runs assigned to that period. The
change SHALL NOT alter any existing metric definition, and SHALL NOT require new run-artifact
fields or new instrumentation.

A period containing no included runs SHALL still appear in the series. Its `totals` counts
SHALL be `0` and its metrics SHALL follow this capability's existing zero-denominator rule —
rate ratios SHALL be `null` rather than `0`, and duration aggregates SHALL report `null` for
`min_ms`, `max_ms`, and `avg_ms`. An empty period SHALL NOT cause an error and SHALL NOT
fabricate values.

Diagnostics SHALL remain a single window-level array; series entries SHALL NOT duplicate the
window's diagnostic objects.

Because per-PR grouping is period-local, a PR with ready runs in more than one period SHALL
contribute to each of those periods' per-PR denominators. The full-window summary SHALL
remain the authoritative de-duplicated aggregate, and its `window`, `totals`, `metrics`, and
`diagnostics` values SHALL be identical whether or not `--bucket` is supplied for the same
window and artifacts.

#### Scenario: each period exposes the full metric set from its own runs
- **WHEN** `pipeline scoreboard --bucket day --json` covers a window in which one included run started on 2026-06-01 and two included runs started on 2026-06-02
- **THEN** the 2026-06-01 entry's `totals.included_runs` SHALL be `1`
- **AND** the 2026-06-02 entry's `totals.included_runs` SHALL be `2`
- **AND** each entry's `metrics` SHALL contain the same metric keys as the full-window `metrics` object

#### Scenario: an empty period is reported with null ratios
- **WHEN** `pipeline scoreboard --bucket day --json` covers a three-day window in which no run started on the middle day
- **THEN** the series SHALL still contain an entry for the middle day
- **AND** that entry's `totals.included_runs` SHALL be `0`
- **AND** its `ready_to_deploy_without_human_intervention.ratio` SHALL be `null`
- **AND** its `full_run_duration_ms.avg_ms` SHALL be `null`

#### Scenario: the full-window summary is unaffected by bucketing
- **WHEN** `pipeline scoreboard --json` and `pipeline scoreboard --json --bucket week` are invoked over the same window and the same run artifacts
- **THEN** the two reports' `window`, `totals`, `metrics`, and `diagnostics` values SHALL be identical
- **AND** the bucketed report SHALL differ only by the additive bucket and series keys

### Requirement: Bucketed output is emitted in both human and JSON form and rejects unsupported units

When `--bucket` is supplied with `--json`, the command SHALL write exactly one unfenced JSON
object containing an additive top-level bucket key holding the selected unit and an additive
top-level series key holding the ordered array of per-period entries. Each entry SHALL contain
at minimum `start`, `end`, `totals`, and `metrics`. These keys SHALL be additive: the report's
`schema_version` SHALL remain unchanged and all pre-existing keys SHALL retain their meaning.

When `--bucket` is supplied without `--json`, the human-readable report SHALL render the same
series as a per-period section, one labelled group per period, in the same chronological order
as the JSON series, including empty periods.

When `--bucket` is supplied with any value other than `day` or `week`, the command SHALL fail
with an error message naming the supported values, SHALL exit non-zero, and SHALL NOT write any
report output to stdout.

#### Scenario: JSON output carries a parseable series
- **WHEN** `pipeline scoreboard --bucket week --json` is invoked
- **THEN** stdout SHALL contain exactly one JSON object and `JSON.parse(stdout)` SHALL succeed
- **AND** the parsed object SHALL contain a bucket value of `week` and a series array
- **AND** each series element SHALL contain `start`, `end`, `totals`, and `metrics`

#### Scenario: human output renders the same series
- **WHEN** `pipeline scoreboard --bucket day` is invoked without `--json` over a window spanning three days
- **THEN** stdout SHALL include the existing full-window summary
- **AND** stdout SHALL include a per-period section with one labelled group per day, in chronological order

#### Scenario: an unsupported bucket unit fails without partial output
- **WHEN** `pipeline scoreboard --bucket month --json` is invoked
- **THEN** the command SHALL exit with a non-zero status
- **AND** stderr SHALL name `day` and `week` as the supported values
- **AND** stdout SHALL contain no scoreboard report
