## ADDED Requirements

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
