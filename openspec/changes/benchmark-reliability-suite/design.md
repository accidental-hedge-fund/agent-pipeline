## Context

The pipeline already uses a `deps`/`Deps` injectable seam pattern throughout (`AdvanceReviewDeps`, `ShaGateDeps`, `VerifyDeps`, etc.) so that unit tests avoid real network, git, and subprocess calls. The benchmark/reliability suite exploits that same seam — it does not need new infrastructure, only disciplined use of existing fakes.

Node 24's built-in `node:test` runner (used by `npm test`) supports `performance.now()` for sub-millisecond timing. Percentile computation is straightforward over small arrays (≤50 samples per scenario); no external benchmarking library is needed.

## Goals / Non-Goals

**Goals**
- Six hotspot scenarios, each producing structured timing/call-count output that assertions can verify.
- Reliability "red tests" that fail without the production fix in place, proving the test bites.
- Zero real I/O — all fakes, consistent with the project's unit-test philosophy.
- Cheap enough to run on every `npm test` invocation (total wall time < 10 s on a developer laptop).

**Non-Goals**
- CI performance regression gating (no absolute time thresholds committed to CI — laptop variance makes that brittle). The baseline is observational.
- Load/soak testing with real processes.
- Replacing the existing behavior tests.

## Decisions

**Decision: single new test file, no new production code.**
The suite lives entirely in `core/test/benchmark-reliability.test.ts` (with a small `bench-helpers.ts` for shared utilities). No `core/scripts/` changes are needed — the hotspots are already reachable via existing fakes. This keeps the blast radius zero for the production mirror.

**Decision: structured result objects, not console output.**
Each benchmark emits a `BenchmarkResult` object `{ scenario, p50_ms, p95_ms, gh_call_count, stage_duration_ms }`. Tests assert the fields exist and are non-negative numbers. This keeps the suite parseable and avoids relying on stdout formatting.

**Decision: fake gh call counter via the `gh` dep injection.**
The `gh` fake increments an in-memory counter on every call. Tests read `counter.calls` after exercising the stage under test to assert call-count budgets (e.g. "status with 50 worktrees SHALL NOT exceed N `gh` calls").

**Decision: worktree-count parametrization via array of sizes.**
Status latency benchmarks run at [1, 10, 50] worktree counts by passing a synthetic worktree list to the fake. Each size is its own `it()` block so results appear individually in the test report.

**Decision: reliability "red test" convention.**
Each reliability scenario includes a comment block `// RED: fails without <fix> because <reason>` immediately above the assertion. The tasks list requires the implementer to manually verify the test fails before the fix and passes after.

**Decision: partial-failure scenario targets label-not-applied.**
The known partial-transition failure mode is: the harness writes a PR comment but the `gh label add` call throws. The fake injects a throwing `gh` for the label call only, and the test asserts the stage transitions to `blocked` rather than silently advancing with the wrong label.

**Decision: artifact-corruption scenario targets `summary.json` missing + malformed.**
The known artifact-corruption mode is: `summary.json` is absent or contains invalid JSON. The fake returns `null` / a non-JSON string from the artifact reader. The test asserts the stage surfaces a clear error state rather than throwing uncaught.

## Risks / Trade-offs

- *Fake-vs-real divergence*: fakes that don't accurately mirror production `gh` behavior could give false confidence. Mitigation: keep fakes thin (returning the minimal shape the stage actually reads); the existing behavior tests already validate the real shape.
- *Timing assertions are fragile on slow CI*: mitigated by not asserting absolute p50/p95 thresholds in the green path — only structure (field presence and non-negativity). Humans read the emitted values for baseline insight.
