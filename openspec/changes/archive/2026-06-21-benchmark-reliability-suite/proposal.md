## Why

Current tests verify behavior correctness but establish no performance baselines or failure-mode budgets for the pipeline's central runtime paths — status lookup, GitHub call throughput, worktree scaling, harness timeout, and partial-failure recovery. Without baselines, regressions in these hotspots are invisible until they manifest as user-facing slowness or silent data loss.

## What Changes

- New test module `core/test/benchmark-reliability.test.ts` (and helper utilities) covering six hotspot scenarios using fake deps — no real network, git, or subprocess calls.
- Benchmarks report **p50/p95 wall time**, **`gh` call count**, and **stage duration** for each scenario.
- Reliability tests assert fail-before-fix for the known failure modes: partial GitHub transition failure (label not applied) and artifact corruption/missing files.
- A `README` section documents how to run the suite and interpret its output.

## Capabilities

### New Capabilities
- `benchmark-reliability-suite`: A lightweight benchmark and reliability regression suite covering pipeline hotspot paths, runnable locally with fake deps and producing structured timing and call-count output.

### Modified Capabilities
<!-- None: no existing spec requirements change. The suite is purely additive. -->

## Impact

- `core/test/benchmark-reliability.test.ts` (new) and any helper utilities extracted into `core/test/bench-helpers.ts`.
- No changes to `core/scripts/` or `plugin/` — the suite exercises existing production code through its injectable dep seams.
- `README` gains a "Benchmark & Reliability Suite" section.

## Acceptance Criteria

- [ ] Running `npm test` (from `core/`) executes the benchmark/reliability suite alongside existing tests and all pass.
- [ ] The suite covers all six hotspot scenarios: status latency with variable worktree counts (1, 10, 50), stage-loop `gh` call count verification, pre-merge polling call-count cap, harness timeout descendant cleanup, partial GitHub transition failure, and artifact corruption/missing file recovery.
- [ ] Each benchmark scenario emits a structured result with at minimum: `p50_ms`, `p95_ms`, `gh_call_count`, and `stage_duration_ms`; the test asserts these are present and numeric.
- [ ] Each reliability scenario has a "red test" (fails without the target behavior in place) documented in the task list, proving the test bites.
- [ ] No benchmark or reliability test makes real network, git, or subprocess calls — all I/O is injected via the existing `deps`/`Deps` seam pattern.
- [ ] `npm run ci` passes green after the suite is added.
