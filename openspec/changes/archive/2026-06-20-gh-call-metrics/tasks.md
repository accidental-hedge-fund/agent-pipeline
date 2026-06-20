## 1. Define GhMetricsCollector in gh.ts

- [ ] 1.1 Define the `GhMetricsCollector` class in `core/scripts/gh.ts` with: `record(category: string, elapsedMs: number): void`, `summary(): GhMetricsSummary` (returns `call_count`, `total_ms`, `p50_ms`, `p95_ms`, `slowest_calls`). Use a sorted-insertion approach over all elapsed times; cap `slowest_calls` at 5 entries.
- [ ] 1.2 Extend `GhRunOptions` with an optional `collector?: GhMetricsCollector` field.
- [ ] 1.3 Bracket the `execFileAsync` call in `ghRun` with `performance.now()` timestamps; call `opts.collector?.record(category, elapsedMs)` after each attempt completes (success or final failure), where `category = args.slice(0, 2).join(" ")`.
- [ ] 1.4 Write unit tests in `core/test/gh.test.ts` (or nearest co-located test) covering:
  - `record()` increments `call_count` and accumulates `total_ms`
  - `p50_ms` / `p95_ms` computed correctly for a known sample set
  - `slowest_calls` capped at 5 and ordered by `elapsed_ms` descending
  - `summary()` with zero records returns all-zero values
  - `category` is first-two-args only (no body/flag values)

## 2. Add GhMetricsSummaryEvent to run-store.ts

- [ ] 2.1 Add `GhMetricsSummaryEvent` interface to `run-store.ts` (fields: `schema_version`, `type: "gh_metrics_summary"`, `at`, `call_count`, `total_ms`, `p50_ms`, `p95_ms`, `slowest_calls`).
- [ ] 2.2 Add `GhMetricsSummaryEvent` to the `RunEvent` union type.
- [ ] 2.3 Add an `emitGhMetrics(runDir: string, summary: GhMetricsSummary, deps: RunStoreDeps)` helper that calls `appendEvent` with the `gh_metrics_summary` event; wrap in try/catch (non-fatal, logs warning on error).
- [ ] 2.4 Call `emitGhMetrics` inside `finalizeRun`, immediately before the `run_complete` event is appended.
- [ ] 2.5 Write unit tests in `core/test/run-store.test.ts` covering:
  - `emitGhMetrics` appends a correctly structured event line
  - I/O error from `appendFile` is caught and does not propagate
  - Event line contains `schema_version: 1` and no raw arg values

## 3. Thread the collector through pipeline.ts

- [ ] 3.1 In `pipeline.ts`, instantiate a `new GhMetricsCollector()` at the start of each dispatch cycle.
- [ ] 3.2 Pass the collector to every `ghRun` call via `GhRunOptions.collector` — either by threading it through `PipelineConfig` / a dispatch context object, or by injecting it into the `gh.ts` helper functions that call `ghRun` (e.g., `getIssueDetail`, `addLabel`, etc.).
- [ ] 3.3 Pass the collector (or its `summary()` output) to `finalizeRun` so `emitGhMetrics` can use it.

## 4. Verify and finalize

- [ ] 4.1 Run a local pipeline invocation against a real issue (or use a dry-run / test fixture) and confirm `events.jsonl` contains a `gh_metrics_summary` line with plausible `call_count` and timing values.
- [ ] 4.2 Confirm `slowest_calls` entries have only `category` and `elapsed_ms` — no raw body, token, or flag-value args.
- [ ] 4.3 Run `npm run ci` from the repo root; all tests must pass.
- [ ] 4.4 Regenerate the plugin mirror: `node scripts/build.mjs` and commit the updated `plugin/` together with the `core/` changes.
