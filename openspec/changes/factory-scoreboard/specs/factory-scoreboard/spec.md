## ADDED Requirements

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
