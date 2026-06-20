# gh-call-metrics Specification

## Purpose
TBD - created by archiving change gh-call-metrics. Update Purpose after archive.
## Requirements
### Requirement: ghRun records timing and category for every call
The `ghRun` function SHALL record the wall-clock start and end time of every `gh` subprocess invocation and derive an `elapsed_ms` value. It SHALL also derive a `category` string from the first two `gh` args (e.g. `"issue view"`, `"pr create"`, `"label add"`) to classify the call without capturing args that may contain user-supplied content or secrets. The raw arg list SHALL NOT be stored.

#### Scenario: timing is captured for a successful call
- **WHEN** `ghRun(["issue", "view", "42", "--json", "labels", "-R", "owner/repo"])` is called and succeeds
- **THEN** the collector SHALL receive a record with `category: "issue view"` and `elapsed_ms` ≥ 0
- **AND** no arg beyond the first two SHALL appear in the stored record

#### Scenario: timing is captured for a failed call
- **WHEN** `ghRun` is called and `gh` exits with a non-zero status
- **THEN** the collector SHALL still receive the timing record before the error is thrown
- **AND** `elapsed_ms` SHALL reflect the actual time the subprocess ran

#### Scenario: category is capped at two words
- **WHEN** `ghRun` is called with args `["api", "graphql", "--field", "query=..."]`
- **THEN** `category` SHALL be `"api graphql"` — only the first two elements joined by a space

---

### Requirement: GhMetricsCollector accumulates per-run stats
The pipeline engine SHALL maintain one `GhMetricsCollector` instance per dispatch cycle. The collector SHALL track: total call count, cumulative elapsed ms across all calls, and an internal sorted structure sufficient to compute p50 and p95 latency percentiles. The collector SHALL also retain the top-5 slowest calls (by `elapsed_ms`) for inclusion in the summary event.

#### Scenario: call count increments on each ghRun invocation
- **WHEN** `ghRun` is called three times during a run
- **THEN** the collector's call count SHALL be 3 after all three calls complete

#### Scenario: p50 and p95 are computed correctly over a sample set
- **WHEN** the collector has recorded elapsed times [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] ms
- **THEN** `p50_ms` SHALL be 55 (median of 10 values) and `p95_ms` SHALL be 95 (95th percentile)

#### Scenario: top-5 slowest calls are tracked accurately
- **WHEN** more than 5 calls have been recorded
- **THEN** `slowest_calls` SHALL contain at most 5 entries, ordered by `elapsed_ms` descending
- **AND** each entry SHALL contain only `category` and `elapsed_ms`

#### Scenario: zero calls yields a zero-value summary
- **WHEN** no `ghRun` invocations occur during a run
- **THEN** the collector SHALL report `call_count: 0`, `total_ms: 0`, `p50_ms: 0`, `p95_ms: 0`, and `slowest_calls: []`

---

### Requirement: gh_metrics_summary event is appended to events.jsonl at run completion
At the end of every pipeline dispatch cycle, the engine SHALL append a `gh_metrics_summary` event to `events.jsonl` after all run-scoped `gh` calls complete, including any notification calls (e.g. `getPrForIssue`, `postPrComment`). The event SHALL be appended after the `run_complete` event so that notification gh calls are reflected in the count. The event SHALL carry: `schema_version`, `type: "gh_metrics_summary"`, `at` (ISO 8601 UTC timestamp), `call_count` (integer), `total_ms` (integer), `p50_ms` (integer), `p95_ms` (integer), and `slowest_calls` (array of up to 5 `{ category: string; elapsed_ms: number }` objects). The write SHALL be non-fatal: any I/O error SHALL be caught, logged as a warning, and SHALL NOT affect the pipeline outcome.

#### Scenario: metrics summary event appears in events.jsonl after a run
- **WHEN** a pipeline dispatch cycle completes normally
- **THEN** `events.jsonl` SHALL contain a line where `type === "gh_metrics_summary"`
- **AND** that line SHALL include `call_count`, `total_ms`, `p50_ms`, `p95_ms`, and `slowest_calls`

#### Scenario: I/O error writing the summary does not abort the run
- **WHEN** the `appendFile` call for `gh_metrics_summary` throws an error
- **THEN** the pipeline SHALL log a warning and continue to completion
- **AND** the final pipeline state SHALL not be affected

#### Scenario: summary event omits raw gh args
- **WHEN** a `ghRun` call used args containing a PR body or other user-supplied text
- **THEN** the `gh_metrics_summary` event SHALL NOT contain any of those raw args
- **AND** `slowest_calls` entries SHALL contain only `category` and `elapsed_ms`

