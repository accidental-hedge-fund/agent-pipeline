## Context

`core/scripts/scoreboard.ts` today runs a two-phase pipeline: `scanRunStore()` reads
`.agent-pipeline/runs/*/{run.json,events.jsonl,summary.json}` and returns a `ScanResult`
of runs whose resolved start timestamp is inside the window, then `aggregateRuns(window,
scan, estimates)` reduces that set into a single `ScoreboardReport`. Adding a time series
means running the second phase once per period over a partition of the same scanned runs.

Constraint from the issue: the no-`--bucket` output must be unchanged, existing metric
definitions must not move, and no new run-artifact fields may be introduced.

## Goals / Non-Goals

Goals:
- Reuse the exact existing metric reducer per period, so period metrics cannot drift from
  window metrics.
- Deterministic, timezone-free period boundaries.
- Explicit empty periods.

Non-Goals:
- Custom bucket sizes (`--bucket 3d`), configurable timezones, or a rolling/trailing
  window mode.
- New metrics that only make sense in a series (deltas, trend lines, sparklines).

## Decisions

### 1. Partition the already-scanned runs; do not rescan per period

`scanRunStore()` is the only I/O. Bucketing partitions its `runs[]` by
`run.startAt` and calls the existing metric reducer once per partition. Rescanning per
period would multiply artifact reads by the period count and risk the series disagreeing
with the summary.

Consequence: `aggregateRuns()` is refactored so the reducer body is callable with an
arbitrary `(window, runs)` pair. The full-window call keeps its current arguments, which
is what protects the "unchanged when `--bucket` is omitted" guarantee.

### 2. UTC-only, fixed boundaries

`day` = UTC calendar day (`00:00:00.000Z` → next `00:00:00.000Z`). `week` = ISO-8601
week, Monday `00:00:00.000Z` → next Monday `00:00:00.000Z`. The issue explicitly puts
timezone configuration out of scope, and every timestamp in the run store is already
serialized as UTC ISO-8601 (`isoFromUnknown` normalizes via `toISOString()`). A local
timezone would make the same artifacts produce different series on different machines.

### 3. Half-open period intervals, clipped to the window

Each period is `[start, end)`, so a run whose timestamp lands exactly on a boundary
belongs to the later period and is never double-counted. The first period's `start` is
clamped to `window.since` and the last period's `end` to `window.until`, so the series
covers exactly the selected window rather than spilling past it.

Trade-off: the first and last periods are partial and their metrics are not directly
comparable to full interior periods. This is accepted — clipping is the only option that
keeps `sum(series runs) == totals.included_runs`, which is the invariant maintainers
will actually check. The partial-ness is visible from each entry's `start`/`end`.

Note on the window's upper bound: `isInsideWindow` is inclusive of `window.until`, so a
run at exactly `until` is included in the window. It is assigned to the final period,
whose `end` equals `until`; the final period is therefore closed at its upper end. This
is the only exception to the half-open rule and it exists solely to keep the series
partition total over the window's runs.

### 4. Additive, conditional JSON keys — `schema_version` stays `1`

`bucket` (`"day" | "week"`) and `series` (array) are emitted only when `--bucket` is
supplied. Existing consumers that never pass `--bucket` see a byte-identical object, and
consumers that do pass it opted into the new shape. Purely additive optional keys do not
warrant a `schema_version` bump, consistent with how `cost_accounting` and `coverage`
were added to this report.

### 5. Series entries carry `totals` + `metrics`, not `diagnostics`

Diagnostics are artifact-level (corrupt file, missing start time) and several are emitted
during the scan, before any period is known. Duplicating them per period would inflate
`totals.diagnostics` and misreport them as per-period signal. Diagnostics stay a single
window-level array; each series entry's `totals.diagnostics` reports only the count of
diagnostics attributable to runs in that period, and may be `0` even when the window has
diagnostics.

### 6. Per-PR denominators are period-local

`cost_per_ready_pr_usd`, `harness_calls_per_successful_pr`, and
`retry_fix_rounds_per_pr` group by PR number. A PR with ready runs in two periods
contributes one successful-PR denominator unit to each. Consequently the sum of period
numerators/denominators may exceed the window's — the window de-duplicates the PR across
its runs, a period cannot see runs outside itself. This is inherent to per-period
grouping, is documented in the spec, and is why the full-window summary remains the
authoritative aggregate.

## Risks / Trade-offs

- **Series length on wide windows.** `--days 365 --bucket day` yields 365 entries. The
  command is local, read-only, and reducer cost is linear in runs (not periods), so this
  is a rendering-verbosity concern, not a performance one. No cap is imposed — a silent
  truncation would be worse than a long report.
- **Refactoring the reducer risks disturbing window output.** Mitigated by an explicit
  regression test asserting the no-`--bucket` JSON is unchanged, and by the acceptance
  criterion that window `totals`/`metrics` are identical with and without `--bucket`.

## Migration Plan

None required — the flag is opt-in and the default path is unchanged.

## Open Questions

None.
