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

### Requirement: Factory scoreboard supports a self-contained offline HTML export

The `pipeline scoreboard` command SHALL accept an optional `--html <path>` flag. When
supplied, the command SHALL write exactly one complete HTML document to `<path>` rendering
the report for the selected window, and SHALL exit successfully.

The written document SHALL be self-contained and offline: it SHALL contain no external
script, stylesheet, font, image, or other external resource reference; no `@import`; no
absolute or protocol-relative URL; and no runtime network call such as `fetch` or
`XMLHttpRequest`. All styling SHALL be inline within the document. The document SHALL
render completely with networking unavailable.

The command SHALL continue to write its existing human or `--json` output to stdout when
`--html` is supplied; `--html` SHALL be additive rather than a mode switch.

#### Scenario: HTML export writes one complete document

- **WHEN** `pipeline scoreboard --html report.html` is invoked against a repository with run artifacts
- **THEN** the command SHALL exit with status `0`
- **AND** `report.html` SHALL contain a complete HTML document beginning with `<!DOCTYPE html>` and ending with `</html>`

#### Scenario: exported document references no external resource

- **WHEN** a scoreboard HTML export is produced
- **THEN** the document SHALL contain no `<script>` element and no external script reference
- **AND** the document SHALL contain no stylesheet link, `@import`, or external font/image reference
- **AND** the document SHALL contain no `http://`, `https://`, or protocol-relative resource identifier
- **AND** the document SHALL contain no `fetch(` or `XMLHttpRequest` call

#### Scenario: exported document renders offline

- **WHEN** the exported document is opened with networking unavailable
- **THEN** the full report SHALL render
- **AND** every styling rule SHALL be present inline within the document

### Requirement: Scoreboard HTML export reports the same metric values as the terminal report

The HTML export SHALL be rendered from the same report object that produces the command's
human and `--json` output for that invocation, so that no additional scan or aggregation
occurs. For a given window and set of run artifacts, every metric value the command reports
to the terminal SHALL appear in the exported document with the same value.

The export SHALL apply the capability's existing zero-denominator rule: a rate whose
`ratio` is `null` and a duration whose `avg_ms` is `null` SHALL be rendered as an explicit
not-applicable marker, and SHALL NOT be rendered as `0`.

The export SHALL use generic Agent Pipeline terminology and run-artifact-derived values
only, and SHALL NOT introduce organization-, customer-, or branding-specific content, and
SHALL NOT introduce metrics that the terminal report does not compute.

The export SHALL honour the command's other window and shaping flags: `--since`, `--until`,
`--days`, `--estimate-cost`, `--bucket`, and `--by` SHALL affect the exported document
exactly as they affect the terminal report.

#### Scenario: exported values match the terminal report

- **WHEN** `pipeline scoreboard --html report.html` is invoked for a given window and set of run artifacts
- **THEN** every metric value present in the command's human output SHALL appear in `report.html` with the same value

#### Scenario: zero-denominator metrics are rendered as not applicable

- **WHEN** the window contains no runs contributing to a given rate or duration metric
- **THEN** that metric SHALL be rendered in the exported document as an explicit not-applicable marker
- **AND** that metric SHALL NOT be rendered as `0`

#### Scenario: window and shaping flags apply to the export

- **WHEN** `pipeline scoreboard --days 7 --bucket day --by harness --html report.html` is invoked
- **THEN** `report.html` SHALL reflect the same 7-day window, per-period series, and per-harness grouping the terminal report shows for the same invocation

#### Scenario: run-derived strings are escaped

- **WHEN** a run artifact contributes a stage, harness, group key, or diagnostic string containing HTML metacharacters such as `<`, `&`, or `"`
- **THEN** those characters SHALL be escaped in the exported document
- **AND** the string SHALL NOT be interpreted as markup

### Requirement: Scoreboard HTML export never publishes or mutates state

The HTML export SHALL be read-only with respect to all state other than the destination
file. It SHALL NOT invoke any GitHub command, SHALL NOT create, modify, or delete any file
under `.agent-pipeline/runs/`, and SHALL NOT upload, publish, email, or otherwise transmit
the report or any run artifact to any external system.

When `--html` is omitted, the command SHALL behave exactly as before: no file SHALL be
written, and human and `--json` output SHALL be unchanged.

#### Scenario: export mutates nothing but the destination file

- **WHEN** `pipeline scoreboard --html report.html` is invoked
- **THEN** no GitHub command SHALL be invoked
- **AND** no file under `.agent-pipeline/runs/` SHALL be created, modified, or deleted
- **AND** no data SHALL be transmitted to any external system

#### Scenario: omitting the flag changes nothing

- **WHEN** `pipeline scoreboard` or `pipeline scoreboard --json` is invoked without `--html`
- **THEN** the output SHALL be identical to the output produced before this capability was added
- **AND** no file SHALL be written

### Requirement: Scoreboard HTML export writes atomically and fails clearly on invalid paths

The export SHALL render the complete document before writing any bytes, SHALL write to a
temporary file within the destination's own directory, and SHALL rename that temporary file
onto the destination, so that the destination is never observed partially written.

When the destination path is invalid or unwritable — including a non-existent parent
directory, a destination that is an existing directory, or a directory the process cannot
write to — the command SHALL exit non-zero with an error message naming the destination
path, SHALL remove any temporary file it created, and SHALL leave no partial file at the
destination. The command SHALL NOT create missing parent directories.

Repeated exports over unchanged inputs — the same run artifacts, window bounds, and flags —
SHALL render the same metric values. The export SHALL NOT embed values derived from the
current clock, randomness, or the environment that would vary between such exports.

#### Scenario: invalid destination path fails without a partial file

- **WHEN** `pipeline scoreboard --html <path>` is invoked and `<path>`'s parent directory does not exist, or `<path>` is an existing directory, or the destination directory is not writable
- **THEN** the command SHALL exit non-zero with an error naming `<path>`
- **AND** no file SHALL exist at `<path>` as a result of the invocation
- **AND** no temporary file SHALL remain beside `<path>`

#### Scenario: a failure during writing leaves no partial file

- **WHEN** the export fails after starting to write the temporary file
- **THEN** the temporary file SHALL be removed
- **AND** any pre-existing file at the destination SHALL be left unchanged

#### Scenario: repeated exports over unchanged inputs are stable

- **WHEN** `pipeline scoreboard --html report.html` is invoked twice with identical flags and explicit window bounds over an unchanged run store
- **THEN** the rendered metric values SHALL be the same in both exports

### Requirement: Factory scoreboard reports repeat-correction metrics deduped by correction instance

The `pipeline scoreboard` command SHALL read `correction_event` records from the included runs'
existing artifacts and report repeat-correction metrics in both the human-readable report and the
`--json` object: the total number of corrections, the number of distinct correction classes, the
repeated-class count and repeated-class rate, and corrections per ready-to-deploy item. A
correction class SHALL be a distinct `correction_key`. Corrections SHALL be counted by distinct
`correction_id`, so replayed or duplicate deliveries of one correction count exactly once. A
repeated class SHALL be a class with two or more distinct corrections. Consistent with this
capability's existing zero-denominator rule, the repeated-class rate and corrections-per-ready-item
SHALL be `null` rather than `0` when their denominator is zero.

#### Scenario: duplicate correction delivery counts once

- **WHEN** the included runs contain two `correction_event` records sharing one `correction_id`
- **THEN** the total-corrections count SHALL increase by exactly one for that `correction_id`

#### Scenario: repeated-class count and rate reported

- **WHEN** the included runs contain three distinct corrections across two `correction_key` classes, one class holding two distinct corrections
- **THEN** the distinct-class count SHALL be `2`
- **AND** the repeated-class count SHALL be `1`
- **AND** the repeated-class rate SHALL expose numerator `1` and denominator `2`

#### Scenario: corrections per ready-to-deploy item uses the successful-PR denominator

- **WHEN** the window has two successful ready-to-deploy PRs and four distinct corrections
- **THEN** corrections-per-ready-item SHALL expose numerator `4` and denominator `2`
- **AND** when there are zero successful PRs the metric SHALL be `null` rather than `0`

### Requirement: Factory scoreboard attributes controls and reports time-to-control

The `pipeline scoreboard` command SHALL read `control_attribution` records from the durable
attribution store and join them to correction classes by `correction_key`. For each class with an
`implemented` attribution, the report SHALL expose the attributed `control_type`, the resolving
issue/PR and effective commit or release, and a `time-to-control` equal to the interval from the
class's first-seen correction timestamp to the attribution's `effective_at`. The scoreboard SHALL
NOT infer attribution from issue or PR activity; only records from the attribution store SHALL
attribute a control.

#### Scenario: an attributed class reports its control and time-to-control

- **WHEN** a `correction_key` was first seen at T0 and an `implemented` `control_attribution` for it has `effective_at = T1`
- **THEN** the report SHALL show that class's `control_type` and resolving issue/PR
- **AND** its `time-to-control` SHALL be the interval from T0 to T1

#### Scenario: an unattributed class reports no control

- **WHEN** a recurring `correction_key` has no `control_attribution` in the store
- **THEN** the report SHALL show the class as unattributed
- **AND** it SHALL NOT synthesize a control from a closed issue or merged PR

### Requirement: Factory scoreboard measures post-control recurrence only over eligible exposure

For each `correction_key` with an `implemented` attribution, the scoreboard SHALL measure
recurrence only over **subsequent eligible run exposure**: included runs whose resolved start
timestamp (the same timestamp used for window filtering) is strictly after the attribution's
`effective_at` and that exercised the class's stage — evidenced by a `stage_start`/`stage_complete`
for that stage, or, for a null-stage class, any included run after the boundary. The scoreboard
SHALL classify each attributed class as exactly one of `recurred` (an eligible post-control run
emitted the class), `no_recurrence_observed` (one or more eligible post-control runs, none of which
emitted the class), or `insufficient_post_control_evidence` (zero eligible post-control runs). A
class with zero eligible post-control runs SHALL NOT be reported as `no_recurrence_observed`.

#### Scenario: recurrence after a gate falls to no recurrence observed

- **WHEN** a class has an `implemented` `deterministic-gate` attribution and two eligible post-control runs, neither emitting the class
- **THEN** the class SHALL be classified `no_recurrence_observed`

#### Scenario: a documentation-only control that keeps recurring is reported as recurred

- **WHEN** a class has an `implemented` `instruction` attribution and an eligible post-control run still emits the class
- **THEN** the class SHALL be classified `recurred`
- **AND** the report SHALL NOT present the documentation-only control as having stopped the correction

#### Scenario: zero post-control exposure is insufficient evidence

- **WHEN** a class has an `implemented` attribution but no included run started after `effective_at` that exercised its stage
- **THEN** the class SHALL be classified `insufficient_post_control_evidence`
- **AND** it SHALL NOT be classified `no_recurrence_observed`

### Requirement: Factory scoreboard reports recurrence temporally and surfaces superseded and rolled-back controls

The scoreboard SHALL report recurrence as temporal attribution and evidence, and SHALL NOT claim
that a control caused a change in recurrence. When a `control_attribution` carries a `supersedes`
pointer, the scoreboard SHALL use the latest non-`rejected` implemented attribution as the class's
active boundary, SHALL re-measure recurrence from that boundary, and SHALL surface the superseded
or rolled-back control in the report rather than hiding it.

#### Scenario: report avoids a causal claim

- **WHEN** the recurrence report is rendered for an attributed class
- **THEN** it SHALL state the control's effective time and the observed recurrence over eligible exposure
- **AND** it SHALL NOT assert that the control caused the recurrence change

#### Scenario: superseded control is re-measured from the new boundary and shown

- **WHEN** attribution B supersedes an earlier implemented attribution A for one `correction_key`
- **THEN** post-control recurrence SHALL be measured from B's `effective_at`
- **AND** the report SHALL still surface A as superseded rather than omitting it

### Requirement: Factory scoreboard groups correction metrics by a single correction dimension

The `pipeline scoreboard` command SHALL accept an optional `--corrections-by <dimension>` flag
whose only supported values are `repo`, `stage`, `harness`, `model`, `source_kind`,
`failure_class`, `proposed_control`, and `implemented_control`. Exactly one dimension SHALL be
accepted per invocation. When `--corrections-by` is supplied, the report SHALL include an additive
grouping of the repeat-correction and recurrence metrics by that dimension, in both human and
`--json` form. When it is supplied with an unsupported value, or supplied more than once, the
command SHALL fail with an error naming the supported values (or stating exactly one dimension is
supported), SHALL exit non-zero, SHALL write no report output to stdout, and SHALL validate before
any run artifact is read. When the flag is omitted, output SHALL be unchanged and no
grouping-related key SHALL appear.

#### Scenario: grouping by failure class produces one entry per class

- **WHEN** `pipeline scoreboard --corrections-by failure_class --json` is invoked over a window whose corrections span two failure classes
- **THEN** the report SHALL contain a correction-grouping result whose dimension is `failure_class`
- **AND** it SHALL contain exactly one entry per distinct `failure_class`

#### Scenario: an unsupported correction dimension fails without partial output

- **WHEN** `pipeline scoreboard --corrections-by team --json` is invoked
- **THEN** the command SHALL exit non-zero
- **AND** stderr SHALL name the supported dimensions
- **AND** stdout SHALL contain no scoreboard report

#### Scenario: omitting the flag leaves output unchanged

- **WHEN** `pipeline scoreboard --json` is invoked without `--corrections-by`
- **THEN** the parsed JSON object SHALL NOT contain a correction-grouping key
- **AND** the human report SHALL NOT contain a correction-grouping section

### Requirement: Factory scoreboard reports recurrence trends and the top still-recurring classes

When `--bucket` is supplied, each series period SHALL additionally carry its own repeat-correction
totals, so the report shows rolling-window recurrence trends alongside the existing per-period
metrics. Independently of bucketing, the report SHALL include a top-still-recurring-classes list —
the classes with the most post-control recurrence (or, when unattributed, the most in-window
recurrence) — each with sanitized evidence pointers to originating corrections. Every evidence
pointer and excerpt SHALL pass the engine's secret redaction and injection screening before it
appears in any report line or `--json` field.

#### Scenario: bucketed periods carry recurrence totals

- **WHEN** `pipeline scoreboard --bucket day --json` covers a window with corrections on two days
- **THEN** each series period SHALL expose its own repeat-correction totals
- **AND** the per-period totals SHALL sum to the window's total corrections

#### Scenario: top still-recurring classes carry sanitized evidence pointers

- **WHEN** the report lists the top still-recurring correction classes
- **THEN** each listed class SHALL include at least one evidence pointer to an originating correction
- **AND** a pointer or excerpt containing a recognized secret SHALL appear only in redacted form

### Requirement: Factory scoreboard recurrence reporting is read-only and tolerant of bad artifacts

The recurrence and attribution reporting SHALL be read-only: it SHALL invoke no GitHub command,
SHALL NOT create, modify, or delete any file under `.agent-pipeline/runs/`, and SHALL NOT write the
attribution store. Malformed, partial, or old-schema `correction_event` and `control_attribution`
records, and attributions referencing an unknown `correction_key`, SHALL be surfaced as window-level
diagnostics with stable reason codes rather than silently skewing a metric or crashing the scan.

#### Scenario: recurrence reporting mutates nothing

- **WHEN** `pipeline scoreboard` computes recurrence and attribution metrics over a window
- **THEN** no GitHub command SHALL be invoked
- **AND** no file under `.agent-pipeline/runs/` and no attribution store file SHALL be created, modified, or deleted

#### Scenario: malformed correction or attribution record is diagnosed, not fatal

- **WHEN** the scan encounters a malformed or unknown-schema `correction_event` or `control_attribution` record
- **THEN** the report SHALL include a diagnostic with a stable reason code identifying it
- **AND** the remaining recurrence metrics SHALL still be computed and the scan SHALL NOT crash

