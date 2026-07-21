# factory-scoreboard Specification

## Purpose
TBD - created by archiving change factory-scoreboard. Update Purpose after archive.
## Requirements
### Requirement: Factory scoreboard scans run artifacts over a configurable window
The pipeline CLI SHALL provide a no-issue-number `pipeline scoreboard` command
that scans `.agent-pipeline/runs/*/` under the repository root and builds a
factory-level report from existing run artifacts. The command SHALL support a
configurable time window using `--since <ISO-8601>`, `--until <ISO-8601>`, and
`--days <positive-integer>`. When no window is supplied, the default window
SHALL be the last 30 days ending at command start.

For each run directory, the scanner SHALL resolve the run start timestamp using
this priority order: `run.json.started_at`, then the first `run_start` event's
`at` timestamp from `events.jsonl`, then a timestamp parsed from the run-id. A
run SHALL be included only when its resolved start timestamp is inside the
window. Runs whose start timestamp cannot be resolved SHALL be excluded and
reported as diagnostics.

The scoreboard command SHALL be read-only. It SHALL NOT mutate GitHub
labels/comments, worktrees, pipeline configuration, or any file under
`.agent-pipeline/runs/`.

#### Scenario: default window is last 30 days
- **WHEN** `pipeline scoreboard` is invoked without `--since`, `--until`, or `--days`
- **THEN** the report window SHALL start 30 days before command start
- **AND** the report window SHALL end at command start

#### Scenario: explicit window filters runs
- **WHEN** `pipeline scoreboard --since 2026-06-01T00:00:00Z --until 2026-06-15T00:00:00Z` is invoked
- **AND** `.agent-pipeline/runs/` contains one run that started on 2026-06-10 and one run that started on 2026-06-20
- **THEN** only the 2026-06-10 run SHALL contribute to the scoreboard metrics
- **AND** the 2026-06-20 run SHALL be ignored without a diagnostic

#### Scenario: run with no resolvable start time is diagnosed
- **WHEN** a run directory has no parseable `run.json.started_at`, no parseable `run_start` event, and no parseable run-id timestamp
- **THEN** that run SHALL be excluded from metrics
- **AND** the report diagnostics SHALL include the run directory path and reason code `missing_start_time`

#### Scenario: scoreboard is read-only
- **WHEN** `pipeline scoreboard` runs against a repository with existing run artifacts
- **THEN** no GitHub command that mutates labels or comments SHALL be invoked
- **AND** no file under `.agent-pipeline/runs/` SHALL be created, modified, or deleted

### Requirement: Factory scoreboard computes throughput, autonomy, cost, and reliability metrics
The scoreboard SHALL compute the following metrics over included runs:

- ready-to-deploy without human intervention rate
- cost per ready PR
- wall-clock duration per full run and per stage
- harness calls per successful PR
- retry/fix-round count per PR
- blocker rate by blocker kind
- `pipeline:needs-human` rate
- same-harness fallback rate
- test, eval, and shipcheck pass rates

A successful PR SHALL be a distinct non-null PR number from an included run whose
final state is `ready-to-deploy` in `summary.json.finalState` or a
`run_complete.final_state` event. If a ready-to-deploy run has no PR number, the
run SHALL be counted in ready-run totals but excluded from per-PR denominators,
and the diagnostics SHALL include reason code `missing_pr_for_ready_run`.

Rates SHALL expose their numerator and denominator. When a denominator is zero,
the ratio SHALL be `null` rather than `0`.

#### Scenario: ready-to-deploy autonomy rate counts no-intervention successes
- **WHEN** two included successful PRs reached `ready-to-deploy`
- **AND** one successful PR's ready run contains no `human_intervention` events and no override records
- **AND** the other successful PR's ready run contains a `human_intervention` event
- **THEN** the ready-to-deploy-without-human-intervention rate SHALL have numerator `1`
- **AND** the denominator SHALL be `2`

#### Scenario: durations are derived from lifecycle timestamps
- **WHEN** an included run has `run_start.at = T0`, `run_complete.at = T2`, `run_complete.elapsed_ms = 120000`, a `stage_start` for `review-1` at T0, and a matching `stage_complete` for `review-1` at T1
- **THEN** the full-run duration metric SHALL include `120000` milliseconds for that run
- **AND** the `review-1` stage duration metric SHALL include the elapsed milliseconds between T0 and T1

#### Scenario: harness calls per successful PR uses recorded harness invocations
- **WHEN** an included successful PR has three recorded harness invocation records across its summary/events
- **THEN** the harness-calls-per-successful-PR metric SHALL count three calls in the numerator
- **AND** that PR SHALL contribute one to the denominator

#### Scenario: blocker rate groups by intervention kind
- **WHEN** included runs contain `human_intervention` events of kinds `test-build-failure`, `review-non-convergence`, and `test-build-failure`
- **THEN** the blocker-rate-by-kind metric SHALL count `test-build-failure: 2`
- **AND** it SHALL count `review-non-convergence: 1`

#### Scenario: same-harness fallback rate uses self-review markers
- **WHEN** included review records contain four review rounds
- **AND** one round has `selfReview: true` or `self_review: true`
- **THEN** the same-harness fallback rate SHALL have numerator `1`
- **AND** the denominator SHALL be `4`

#### Scenario: gate pass rates distinguish pass, fail, and skipped outcomes
- **WHEN** included artifacts prove one eval gate pass, one eval gate fail, and one eval gate skipped because the gate was disabled
- **THEN** the eval pass-rate denominator SHALL be `2`
- **AND** the eval pass-rate numerator SHALL be `1`
- **AND** the skipped eval gate SHALL be reported in a skipped count outside the pass-rate denominator

### Requirement: Factory scoreboard emits human-readable and JSON output
By default, `pipeline scoreboard` SHALL print a human-readable report containing
the selected window, included run count, successful PR count, each required
metric, and a diagnostics section when diagnostics are present.

When `--json` is supplied, the command SHALL write exactly one unfenced JSON
object to stdout with no surrounding prose. The JSON object SHALL contain at
minimum: `schema_version`, `window`, `totals`, `metrics`, and `diagnostics`.
Diagnostics SHALL be an array of objects containing at least `severity`, `code`,
`path`, and `message`.

#### Scenario: human output contains all metric headings
- **WHEN** `pipeline scoreboard` is invoked with included run artifacts
- **THEN** stdout SHALL include the report window
- **AND** stdout SHALL include human-readable entries for all required metrics

#### Scenario: json output is a single parseable object
- **WHEN** `pipeline scoreboard --json` is invoked
- **THEN** stdout SHALL contain exactly one JSON object
- **AND** `JSON.parse(stdout)` SHALL succeed
- **AND** the parsed object SHALL contain `schema_version`, `window`, `totals`, `metrics`, and `diagnostics`

#### Scenario: diagnostics appear in json output
- **WHEN** the scoreboard encounters a corrupt artifact file
- **AND** `pipeline scoreboard --json` is invoked
- **THEN** the parsed JSON SHALL contain a diagnostic with the corrupt file path
- **AND** the diagnostic SHALL include a stable reason code

### Requirement: Historical artifact problems are diagnostics, not crashes
The scoreboard SHALL tolerate missing `.agent-pipeline/runs/`, missing
`summary.json`, missing `events.jsonl`, corrupt JSON files, partial final lines in
`events.jsonl`, and unknown event fields. The command SHALL continue reporting
all metrics that can be proven from remaining artifacts. Artifact problems SHALL
be surfaced as diagnostics rather than unhandled exceptions.

Missing `.agent-pipeline/runs/` SHALL produce a valid empty report with a
diagnostic. A missing or corrupt `summary.json` SHALL NOT prevent event-derived
metrics for the same run from being reported. A partial final `events.jsonl` line
SHALL be ignored consistently with the `events-jsonl-streaming` contract.

#### Scenario: missing run store produces empty report
- **WHEN** `pipeline scoreboard --json` is invoked in a repository with no `.agent-pipeline/runs/` directory
- **THEN** stdout SHALL be a valid scoreboard JSON object
- **AND** `totals.included_runs` SHALL be `0`
- **AND** diagnostics SHALL include reason code `missing_run_store`

#### Scenario: corrupt summary does not suppress event metrics
- **WHEN** an included run has a parseable `events.jsonl`
- **AND** its `summary.json` contains invalid JSON
- **THEN** event-derived metrics for that run SHALL still be included
- **AND** diagnostics SHALL include reason code `corrupt_summary`

#### Scenario: partial final event line is ignored
- **WHEN** `events.jsonl` ends with an incomplete JSON line after one or more complete lines
- **THEN** the scoreboard SHALL use the complete lines
- **AND** it SHALL NOT throw an unhandled parse error for the partial final line

#### Scenario: unknown fields are preserved for diagnostics but do not break aggregation
- **WHEN** an event contains fields unknown to the current scoreboard implementation
- **THEN** the scoreboard SHALL NOT reject the event
- **AND** known fields from the same event SHALL remain available for metric aggregation

### Requirement: Factory scoreboard cost metrics use actual costs or explicit estimates
The scoreboard SHALL classify each recorded harness call's cost source as:
`actual`, `estimated`, or `missing`. A call SHALL be `actual` when its source
artifact record contains a numeric `cost_usd` field or a numeric
`usage.cost_usd` field. A call SHALL be `estimated` when no actual cost is
present and the caller supplied `--estimate-cost <harness>=<usd-per-call>` for
that call's harness. A call SHALL be `missing` when neither actual nor explicit
estimated cost is available.

Actual cost SHALL take precedence over an estimate for the same call. If any
included successful PR has missing-cost calls, `cost_per_ready_pr_usd.value`
SHALL be `null`, and diagnostics SHALL identify the missing harness estimate.
When all included successful PR calls have actual or estimated cost,
`cost_per_ready_pr_usd.value` SHALL be the total actual-plus-estimated USD
divided by the successful PR denominator.

#### Scenario: actual cost wins over supplied estimate
- **WHEN** an included successful PR has one harness call with `cost_usd: 2.50`
- **AND** the caller supplied `--estimate-cost claude=1.00` for that call's harness
- **THEN** the cost total SHALL include `2.50` as actual cost
- **AND** it SHALL NOT replace that call with the `1.00` estimate

#### Scenario: estimate fills missing actual cost
- **WHEN** an included successful PR has one recorded `codex` harness call without actual cost
- **AND** the caller supplied `--estimate-cost codex=0.75`
- **THEN** the cost total SHALL include `0.75` as estimated cost
- **AND** `cost_per_ready_pr_usd.value` SHALL be numeric when no other successful-PR calls are missing cost

#### Scenario: missing cost source makes cost per ready PR unavailable
- **WHEN** an included successful PR has one recorded harness call without actual cost
- **AND** the caller did not supply an estimate for that call's harness
- **THEN** `cost_per_ready_pr_usd.value` SHALL be `null`
- **AND** diagnostics SHALL include reason code `missing_cost_estimate`

### Requirement: Factory scoreboard summarizes stage accounting records by routing dimensions

The `pipeline scoreboard` command SHALL aggregate stage accounting records from
included runs. It SHALL read `summary.json.accounting.records` when available
and SHALL fall back to `stage_accounting` events from `events.jsonl` when the
summary is absent or corrupt. The report SHALL group accounting data by issue,
stage, harness, model slot/model identifier, and outcome.

Each group SHALL expose at minimum: invocation count, total duration
milliseconds, command count, subprocess count, actual cost USD, estimated cost
USD, and unknown cost count. Unknown costs SHALL be reported explicitly and
SHALL NOT be counted as zero-cost invocations.

#### Scenario: JSON output contains grouped accounting totals

- **WHEN** `pipeline scoreboard --json` includes a run with stage accounting
  records
- **THEN** the parsed JSON output SHALL contain cost/accounting groups by issue,
  stage, harness, model slot/model identifier, and outcome
- **AND** each group SHALL include invocation count, duration, command count,
  subprocess count, actual cost USD, estimated cost USD, and unknown cost count

#### Scenario: Human output distinguishes cost sources

- **WHEN** `pipeline scoreboard` includes accounting records with
  `cost_source` values `actual`, `estimated`, and `unknown`
- **THEN** the human-readable report SHALL include a cost/accounting section
- **AND** that section SHALL distinguish actual cost, estimated cost, and
  unknown-cost invocation counts

#### Scenario: Missing summary falls back to accounting events

- **WHEN** an included run has a missing or corrupt `summary.json`
- **AND** the run's `events.jsonl` contains parseable `stage_accounting` events
- **THEN** the scoreboard SHALL aggregate the accounting data from
  `events.jsonl`
- **AND** it SHALL report a diagnostic for the missing or corrupt summary
  without dropping the accounting event data

#### Scenario: Unknown costs are not treated as free

- **WHEN** an included accounting record has `cost_source: "unknown"` and
  `cost_usd: null`
- **THEN** the relevant scoreboard accounting group SHALL increment unknown
  cost count
- **AND** actual and estimated cost totals SHALL remain unchanged for that
  record

### Requirement: Factory scoreboard reports prompt-size telemetry

When stage accounting records contain prompt-size telemetry, the factory scoreboard SHALL aggregate and report it alongside existing stage accounting groups. JSON output SHALL expose total and maximum prompt size per accounting group. Human output SHALL include prompt-size columns or labels in the stage accounting section.

#### Scenario: JSON accounting groups include prompt totals
- **WHEN** `pipeline scoreboard --json` reads stage accounting records with `prompt_chars` and `prompt_estimated_tokens`
- **THEN** each affected accounting group SHALL include total prompt chars, maximum prompt chars, and total estimated prompt tokens

#### Scenario: Human accounting output includes prompt size
- **WHEN** `pipeline scoreboard` prints the stage accounting section
- **AND** included records contain prompt-size telemetry
- **THEN** the section SHALL display prompt-size values so operators can compare slow stages against prompt bulk

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

