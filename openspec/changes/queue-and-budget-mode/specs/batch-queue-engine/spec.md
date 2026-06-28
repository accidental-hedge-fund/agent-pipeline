## ADDED Requirements

### Requirement: The `queue` sub-command SHALL select only eligible issues for autonomous batch processing

The `queue` handler SHALL fetch only issues that are currently in an autonomous-eligible label state (e.g. `pipeline:ready` or equivalent as configured) from the GitHub backlog. Issues in any other pipeline label state SHALL be excluded from the batch and counted as `excluded` in the summary. The handler SHALL further filter the eligible set by the caller-supplied filters: `--label` (intersection of label values; repeatable), `--milestone` (exact milestone title match), and `--risk` (issue risk classification at or below the specified level). After filtering, the handler SHALL rank the remaining issues by a deterministic priority score and select the top `--max-issues` for dispatch. The priority score formula SHALL be a static constant defined in `queue.ts`, auditable without a model call.

#### Scenario: Non-eligible issues are excluded

- **WHEN** the GitHub backlog contains 4 issues with `pipeline:review-1` and 3 issues with `pipeline:ready`
- **THEN** the handler SHALL include only the 3 `pipeline:ready` issues in the candidate set
- **AND** the batch summary SHALL report 4 issues as `excluded`

#### Scenario: Label filter narrows the eligible set

- **WHEN** `--label team:backend` is passed and 2 of 5 eligible issues carry `team:backend`
- **THEN** only the 2 matching issues SHALL enter the candidate set for dispatch

#### Scenario: `--max-issues` caps the batch size

- **WHEN** 20 issues are eligible and pass all filters and `--max-issues 5` is set
- **THEN** the handler SHALL start pipeline runs for exactly 5 issues, ranked by priority score, and SHALL NOT launch runs for the remaining 15

#### Scenario: All filters applied together

- **WHEN** `--label risk:low --milestone v2.0 --max-issues 3` are all specified
- **THEN** only issues carrying `risk:low` AND belonging to milestone `v2.0` SHALL enter the candidate set, and at most 3 SHALL be dispatched

---

### Requirement: The `queue` sub-command SHALL enforce an explicit concurrency cap

The handler SHALL maintain at most `--concurrency C` (default: 1) simultaneously active pipeline runs. When all concurrency slots are occupied, the handler SHALL wait for a running slot to complete before starting the next issue. The concurrency cap SHALL be respected regardless of budget, failure rate, or remaining issue count.

#### Scenario: Concurrency cap limits simultaneous runs

- **WHEN** `--concurrency 2` is set and 5 issues are selected
- **THEN** at no point SHALL more than 2 pipeline runs be active simultaneously
- **AND** each new run SHALL only start after a running slot is freed

#### Scenario: Default concurrency is 1

- **WHEN** `queue` is invoked without a `--concurrency` flag and without a `queue.concurrency` config value
- **THEN** the effective concurrency SHALL be 1 (fully sequential)

---

### Requirement: The `queue` sub-command SHALL enforce a cumulative budget cap

Before launching each new pipeline run, the handler SHALL compare the sum of `cost_usd` across all completed batch runs against `--budget-dollars D`. If the cumulative cost has reached or exceeded `D`, the handler SHALL NOT launch further runs. In-flight runs already active when the cap is reached SHALL be allowed to complete. When no `--budget-dollars` is specified, cost accumulation SHALL be tracked and reported but SHALL NOT block any launch.

#### Scenario: Budget cap halts new launches mid-batch

- **WHEN** `--budget-dollars 1.00` is set, the first two completed runs each cost $0.55 (cumulative $1.10), and a third issue is queued
- **THEN** the third issue SHALL NOT be launched
- **AND** the batch summary SHALL include a `budget_exhausted: true` field and SHALL report the cumulative cost

#### Scenario: In-flight runs complete after budget is reached

- **WHEN** the budget cap is reached while 2 runs are already in flight
- **THEN** both in-flight runs SHALL be allowed to complete before the batch ends

#### Scenario: No budget flag means cost tracked but not enforced

- **WHEN** `queue` is invoked without `--budget-dollars`
- **THEN** cumulative cost SHALL still be accumulated and reported in the summary
- **AND** no run SHALL be blocked due to cost

---

### Requirement: The `queue` sub-command SHALL halt new launches when the failure rate exceeds a threshold

After each run completes, the handler SHALL compute the failure rate as `failedCount / completedCount` where `failed` is any final state that is not `ready-to-deploy` and not `needs-human`. If `completedCount >= 3` and the failure rate meets or exceeds `--max-failure-rate R` (default: 1.0), the handler SHALL stop launching new issues. In-flight runs SHALL be allowed to complete. The halt SHALL be recorded in the batch summary as `failure_rate_halt: true`.

#### Scenario: Failure-rate gate fires at threshold

- **WHEN** `--max-failure-rate 0.5` is set, 3 runs have completed, and 2 of them failed (rate = 0.67)
- **THEN** no further runs SHALL be launched
- **AND** the batch summary SHALL include `failure_rate_halt: true`

#### Scenario: Gate does not fire with fewer than 3 completed runs

- **WHEN** 2 runs have completed and both failed
- **THEN** the gate SHALL NOT fire regardless of `--max-failure-rate`
- **AND** the next queued run SHALL be launched if slots and budget permit

#### Scenario: In-flight runs complete after gate fires

- **WHEN** the failure-rate gate fires while 1 run is already in flight
- **THEN** the in-flight run SHALL complete and its result SHALL be recorded in the summary

---

### Requirement: Per-issue isolation SHALL ensure one run's failure does not affect other batch runs

Each pipeline run in a batch SHALL execute in its own isolated context. An unhandled exception or fatal error from one run SHALL be caught by the queue handler, recorded as `error` in the batch summary for that issue, and SHALL NOT cause the queue handler to exit or cancel other in-flight runs.

#### Scenario: One run crashes, others continue

- **WHEN** the pipeline run for issue #42 throws an unhandled exception during execution
- **THEN** the queue handler SHALL catch the exception and record issue #42 with `final_state: "error"` and an `error` message field in the summary
- **AND** all other in-flight and queued runs SHALL proceed normally
- **AND** the batch summary SHALL be written with the full per-issue outcome list including the failed run

---

### Requirement: The `queue` sub-command SHALL produce a machine-readable `batch-summary.json` artifact

After all runs complete (or the batch is halted by budget exhaustion or failure-rate gate), the handler SHALL write a `batch-summary.json` file to `.agent-pipeline/runs/batch-<batch_id>/batch-summary.json`. The file SHALL contain valid JSON parseable without additional tools. The envelope SHALL include a `schema_version: "1"` field. Pipeline Desk SHALL be able to consume this file without parsing prose logs.

The artifact SHALL contain the following fields:

- `schema_version` (string): `"1"`.
- `batch_id` (string): a unique identifier for this batch run (e.g. `<ISO-8601-timestamp>`).
- `started_at` (string): ISO 8601 timestamp of batch start.
- `ended_at` (string): ISO 8601 timestamp of batch end.
- `halt_reason` (string | null): `"budget_exhausted"`, `"failure_rate_exceeded"`, or `null` if the batch ran to completion.
- `issues` (array): one entry per dispatched issue with fields `number`, `title`, `final_state`, `cost_usd`, `duration_ms`, and optional `error` string.
- `excluded_count` (number): issues in the eligible backlog that were filtered out before selection.
- `aggregate` (object): `{ total_issues, succeeded, failed, excluded_count, failure_rate, total_cost_usd, total_duration_ms }`.
- `limits` (object): the effective limits used for this run — `max_issues`, `budget_dollars`, `concurrency`, `max_failure_rate`.

#### Scenario: Artifact written after normal completion

- **WHEN** 5 issues complete their runs with no halts
- **THEN** `batch-summary.json` SHALL be written to `.agent-pipeline/runs/batch-<id>/batch-summary.json`
- **AND** `JSON.parse(contents)` SHALL succeed
- **AND** `schema_version` SHALL equal `"1"`
- **AND** `halt_reason` SHALL be `null`
- **AND** the `issues` array SHALL contain 5 entries

#### Scenario: Artifact written after budget halt

- **WHEN** the batch is halted by budget exhaustion
- **THEN** `batch-summary.json` SHALL still be written
- **AND** `halt_reason` SHALL equal `"budget_exhausted"`

#### Scenario: Human-readable summary also printed to stdout

- **WHEN** the batch finishes
- **THEN** a human-readable summary SHALL be printed to stdout including a per-issue table (number, title, final state, cost, duration) and an aggregate line
- **AND** the path to `batch-summary.json` SHALL be printed at the end of the summary

---

### Requirement: The `queue` sub-command SHALL never merge any PR

The queue handler SHALL NOT invoke any merge operation, call `pipeline merge`, or set any label or status that would trigger an automatic merge. The autonomous loop's never-auto-merge guarantee SHALL apply to every pipeline run spawned by the queue handler.

#### Scenario: Queue mode does not merge PRs

- **WHEN** a pipeline run reaches `ready-to-deploy` inside a batch
- **THEN** the run SHALL halt at `ready-to-deploy` without merging
- **AND** the batch summary SHALL record the issue's `final_state` as `"ready-to-deploy"` (treated as a success for aggregate metrics)

---

### Requirement: Config sub-key `queue:` SHALL supply operator defaults for all batch limits

The pipeline config schema SHALL accept a `queue:` sub-key in `.github/pipeline.yml` with fields: `max_issues` (number), `budget_dollars` (number), `concurrency` (number), `max_failure_rate` (number, 0.0–1.0). CLI flags SHALL take precedence over config values, which SHALL take precedence over built-in defaults. Unknown sub-keys under `queue:` SHALL cause a strict-schema parse error.

#### Scenario: CLI flag overrides config value

- **WHEN** `.github/pipeline.yml` sets `queue: { concurrency: 3 }` and `--concurrency 1` is passed
- **THEN** the effective concurrency SHALL be 1

#### Scenario: Config value used when no CLI flag

- **WHEN** `.github/pipeline.yml` sets `queue: { budget_dollars: 5.00 }` and no `--budget-dollars` flag is passed
- **THEN** the effective budget limit SHALL be $5.00

#### Scenario: Unknown sub-key in `queue:` is rejected

- **WHEN** `.github/pipeline.yml` contains `queue: { unknownField: true }`
- **THEN** config parsing SHALL fail with a schema error naming the unexpected field
