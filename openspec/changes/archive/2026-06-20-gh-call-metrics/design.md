## Context

`ghRun` in `core/scripts/gh.ts` is the single execution point for all `gh` subprocess calls in the pipeline. It already handles timeout, retry, and error formatting. Adding timing instrumentation here captures 100% of GitHub I/O with a single, contained change and no stage logic modifications.

## Goals / Non-Goals

**Goals:**
- Capture call count, elapsed time, and subcommand category for every `ghRun` invocation.
- Emit a `gh_metrics_summary` event to `events.jsonl` at run completion.
- Keep arg values (potential secrets) out of stored metrics.

**Non-Goals:**
- Per-call events (only the end-of-run aggregate is stored; this avoids JSONL bloat on busy runs).
- Modifying any stage, review logic, or state machine.
- Exposing metrics in the CLI summary prose (out of scope; a follow-up can surface them in `pipeline logs`).
- Network-level tracing or profiling beyond wall-clock subprocess time.

## Decisions

### D1 — Instrument ghRun directly, not via a wrapper

**Decision:** Add `performance.now()` bracketing inside `ghRun` itself; pass timing to a `GhMetricsCollector` ref injected into `ghRun`'s optional deps.

**Rationale:** `ghRun` is already the single call site for all `gh` invocations (the `addIssueComment` / `createIssue` helpers added in #256 also delegate here). A wrapper would require every call site to be updated and would duplicate the retry/timeout logic.

**Alternative considered:** A monkey-patch or module-level singleton. Rejected: singletons make unit tests order-dependent and leak state across test cases.

### D2 — GhMetricsCollector is injected via ghRun's existing GhRunOptions / deps pattern

**Decision:** Extend `GhRunOptions` with an optional `collector?: GhMetricsCollector` parameter. Production code passes the per-run collector; unit tests pass a fake or omit it.

**Rationale:** Matches the established `deps`/`Deps` seam pattern used by `AdvanceReviewDeps`, `ShaGateDeps`, etc. No global state, no module-level mutation, no test isolation issues.

### D3 — Emit gh_metrics_summary immediately before run_complete in finalizeRun

**Decision:** Add a `emitGhMetrics(runDir, collector, deps)` call inside `finalizeRun` (or the `run_complete` emission path in `pipeline.ts`), before the `run_complete` event is appended.

**Rationale:** `finalizeRun` already owns the end-of-run write sequence. Adding the metrics event there keeps the JSONL ordering predictable: `... stage_complete → gh_metrics_summary → run_complete`.

**Alternative considered:** Emit alongside `run_complete` in `pipeline.ts` directly. Rejected: `finalizeRun` is the canonical finalization boundary; `pipeline.ts` should delegate to it rather than knowing about individual event types.

### D4 — Category is first two args only; no body/arg values stored

**Decision:** `category = args.slice(0, 2).join(" ")`.

**Rationale:** First two args are always the `gh` subcommand family (e.g. `["issue", "view", ...]`). Subsequent args are flags and values that may contain user-supplied content, PR bodies, label names, or other data that could be sensitive. Consistent with the arg-redaction requirement in `run-artifact-conventions`.

### D5 — p50/p95 via simple sorted-array percentile

**Decision:** Store all elapsed times in a sorted array (insert-sorted on record). Compute percentiles as `arr[Math.floor(n * p)]` (lower-interpolation).

**Rationale:** Pipeline runs make O(10s)–O(100s) of `gh` calls — never millions. A sorted array is simple, testable, and avoids any external dependency.

## Risks / Trade-offs

- **Memory overhead:** storing all elapsed times per run (O(calls) floats). Acceptable given O(10–100) calls per run.
- **`ghRun` signature change:** adding optional `collector` param is backward-compatible (default `undefined` → no-op).
- **No per-call events in JSONL:** if a debugging workflow wants per-call granularity, a future change can add it. The aggregate is the 80% case.

## Migration Plan

1. Define `GhMetricsCollector` class in `gh.ts`.
2. Add `collector?: GhMetricsCollector` to `GhRunOptions`; instrument timing inside `ghRun`.
3. Add `GhMetricsSummaryEvent` to the `RunEvent` union in `run-store.ts`.
4. Add `emitGhMetrics` helper in `run-store.ts`; call it from `finalizeRun`.
5. Thread the collector from the dispatch entry point in `pipeline.ts` through to `finalizeRun`.
6. Write unit tests for collector accumulation, percentile math, event emission, and secret-exclusion.
7. Run `npm run ci`; regenerate plugin mirror.

No external state migration needed.
