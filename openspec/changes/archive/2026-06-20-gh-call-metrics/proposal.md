## Why

Performance bottlenecks in pipeline runs are difficult to isolate because no data exists on how many `gh` subprocess calls were made or how long they took — it is impossible to tell whether a slow run was caused by network latency, GitHub API rate limits, or logic overhead. Instrumenting `ghRun` (the single shared `gh` wrapper) adds this observability at the only call site that matters, without touching any stage logic.

## What Changes

- `core/scripts/gh.ts`: `ghRun` is wrapped to capture per-call start time, end time, and subcommand category; a run-scoped counter accumulates metrics in memory.
- A new `GhMetricsCollector` (or equivalent in-process singleton/injection point) aggregates call count, total elapsed ms, and a capped list of slowest calls per run.
- At run completion (`finalizeRun` in `run-store.ts`), a `gh_metrics_summary` event is appended to `events.jsonl` with the aggregated stats (count, total_ms, p50_ms, p95_ms, slowest_calls top-5).
- `gh` args that may contain secrets (body text, token values) are NOT recorded; only the subcommand category (e.g. `issue view`, `pr create`, `label add`) is stored.
- No behavioral changes to any stage, state machine, or review logic — purely additive instrumentation.

## Capabilities

### New Capabilities
- `gh-call-metrics`: `ghRun` SHALL instrument every call and accumulate per-run metrics (call count, total ms, p50/p95, slowest-call list); a summary event SHALL be emitted to `events.jsonl` at run completion.

### Modified Capabilities
- `run-artifact-conventions`: The `gh_metrics_summary` event type is a new machine-readable record type; it SHALL carry `schema_version` and follow the non-fatal write convention.

## Impact

- `core/scripts/gh.ts` — `ghRun` gains timing instrumentation; a new `GhMetricsCollector` class/object is introduced.
- `core/scripts/run-store.ts` — new `GhMetricsSummaryEvent` type added to the `RunEvent` union; `finalizeRun` (or the `run_complete` emission path) appends the summary event.
- `core/scripts/pipeline.ts` — must pass the collector reference from run start through to `finalizeRun`.
- No changes to state-machine edges, review logic, or external APIs.
- No changes to `plugin/` beyond the automated mirror regeneration.

## Acceptance Criteria

- [ ] A pipeline run's `events.jsonl` ends with a `gh_metrics_summary` event containing `call_count`, `total_ms`, `p50_ms`, `p95_ms`, and `slowest_calls` (up to 5 entries).
- [ ] `slowest_calls` entries contain `category` (subcommand, e.g. `issue view`) and `elapsed_ms` but no raw `gh` args that could contain secret values.
- [ ] When `ghRun` is called zero times in a run, the event is still emitted with `call_count: 0` and numeric fields set to `0`.
- [ ] The `gh_metrics_summary` event write is non-fatal: an I/O error during emission does not abort the run or affect any pipeline outcome.
- [ ] Unit tests verify: correct metric accumulation across multiple mock calls, correct p50/p95 computation, correct emission on finalize, and secret-arg exclusion from `slowest_calls`.
- [ ] `npm run ci` passes with no regressions.
