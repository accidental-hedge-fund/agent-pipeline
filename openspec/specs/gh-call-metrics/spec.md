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

### Requirement: GhMetricsCollector SHALL accumulate call counts by typed wrapper name

The `GhMetricsCollector` SHALL accept an optional stable typed-wrapper name on each recorded call (for example `getPrDetail` or `getPrChecks`) in addition to the existing CLI `category` and `elapsed_ms`. The collector's summary SHALL expose a `by_wrapper` breakdown that maps each non-empty wrapper name to the integer count of recorded calls for that name. Aggregate fields (`call_count`, `total_ms`, `p50_ms`, `p95_ms`, `slowest_calls`) SHALL continue to include every recorded call regardless of whether a wrapper name was supplied. Calls recorded without a wrapper name SHALL NOT invent a name from CLI args or user content; they SHALL contribute to aggregates and SHALL be omitted from `by_wrapper` (not synthesized under a secret-bearing or arg-derived key).

#### Scenario: Two wrappers accumulate independent counts

- **WHEN** the collector records two calls with wrapper name `getPrDetail` and one call with wrapper name `getPrChecks`
- **THEN** `summary().by_wrapper` SHALL report `getPrDetail: 2` and `getPrChecks: 1`
- **AND** `summary().call_count` SHALL be 3

#### Scenario: Missing wrapper name does not invent a key from args

- **WHEN** the collector records a call with category `pr view` and no wrapper name
- **THEN** `summary().call_count` SHALL include that call
- **AND** `summary().by_wrapper` SHALL NOT contain a key derived from the raw `gh` arg list or category string for that call

#### Scenario: Zero calls yields empty by_wrapper

- **WHEN** no calls have been recorded
- **THEN** `summary().by_wrapper` SHALL be an empty map (or equivalent empty object)
- **AND** aggregate zero-value behavior for `call_count` and latency fields SHALL remain unchanged

---

### Requirement: gh_metrics_summary event SHALL include by_wrapper counts

The `gh_metrics_summary` event appended to `events.jsonl` at run completion SHALL include the collector's `by_wrapper` breakdown alongside existing fields (`call_count`, `total_ms`, `p50_ms`, `p95_ms`, `slowest_calls`). The event SHALL NOT include raw `gh` args, request bodies, tokens, or other user-supplied secret content in wrapper keys or values. The write SHALL remain non-fatal: an I/O error SHALL be logged as a warning and SHALL NOT abort the pipeline outcome.

#### Scenario: Summary event carries by_wrapper after a run with tagged wrappers

- **WHEN** a dispatch cycle records at least one call with a typed wrapper name and then emits `gh_metrics_summary`
- **THEN** the event line SHALL include `type: "gh_metrics_summary"`
- **AND** SHALL include a `by_wrapper` object (or equivalent) whose counts match the collector summary for those wrapper names
- **AND** SHALL still include `call_count`, `total_ms`, `p50_ms`, `p95_ms`, and `slowest_calls`

#### Scenario: by_wrapper keys are wrapper identifiers only

- **WHEN** a typed helper invoked `gh` with args that include a PR body or other user-supplied text
- **THEN** `by_wrapper` keys SHALL be the stable wrapper identifier only
- **AND** no raw arg values from that call SHALL appear in the `gh_metrics_summary` event

---

### Requirement: Typed gh helpers SHALL record their wrapper name when instrumented

Public typed `gh` helper functions that perform a `gh` subprocess invocation through the shared runner SHALL supply their own stable wrapper name to the metrics collector for that invocation when metrics collection is active. The wrapper name SHALL be a fixed code identifier for that helper (for example the helper's export name), not derived from runtime arg content.

#### Scenario: getPrDetail tags its call

- **WHEN** `getPrDetail` is invoked while a metrics collector is active
- **AND** the helper completes a `gh` invocation that is recorded
- **THEN** the collector summary's `by_wrapper` count for `getPrDetail` SHALL increase by one for that invocation

#### Scenario: getPrChecks tags its call

- **WHEN** `getPrChecks` is invoked while a metrics collector is active
- **AND** the helper completes a `gh` invocation that is recorded
- **THEN** the collector summary's `by_wrapper` count for `getPrChecks` SHALL increase by one for that invocation

