## 1. Shared benchmark infrastructure

- [ ] 1.1 Create `core/test/bench-helpers.ts` with `BenchmarkResult` type `{ scenario: string; p50_ms: number; p95_ms: number; gh_call_count: number; stage_duration_ms: number }` and `computePercentiles(samples: number[]): { p50: number; p95: number }` utility.
- [ ] 1.2 Add a `makeGhCounter()` factory in `bench-helpers.ts` that returns a fake `gh` dep which increments `counter.calls` on every invocation and resolves with a configurable stub response.
- [ ] 1.3 Create `core/test/benchmark-reliability.test.ts` importing from `bench-helpers.ts` and scaffolding one `describe("benchmark-reliability-suite")` block.

## 2. Status latency benchmark (variable worktree counts)

- [ ] 2.1 Implement a `describeStatusBenchmark` helper that accepts a worktree count N and a fake-worktree-list factory; runs the status lookup function N samples with fake deps; emits a `BenchmarkResult`.
- [ ] 2.2 Add `it("status latency — 1 worktree")`, `it("status latency — 10 worktrees")`, `it("status latency — 50 worktrees")` using the helper; assert `p50_ms`, `p95_ms`, `gh_call_count`, `stage_duration_ms` are all `>= 0` and numeric.
- [ ] 2.3 Assert that `gh_call_count` does not grow super-linearly: `gh_call_count(50 worktrees) < gh_call_count(1 worktree) * 100` (sanity cap, not a strict budget).

## 3. Stage-loop gh call count benchmark

- [ ] 3.1 Wire a fake `AdvanceReviewDeps`-shaped dep set with the `gh` counter and run one full review-stage iteration through the existing review stage entry point with a minimal fake context.
- [ ] 3.2 Assert the `gh_call_count` per review iteration is within a documented budget (e.g. ≤ 5 calls); record the actual count as the emitted `BenchmarkResult.gh_call_count`.
- [ ] 3.3 Add a comment noting the budget is observational; document actual count in the test.

## 4. Pre-merge polling call-count benchmark

- [ ] 4.1 Inject a fake pre-merge deps that simulates CI polling loop returning "pending" for K iterations then "success"; run the pre-merge polling path.
- [ ] 4.2 Assert `gh_call_count` equals K + 1 (exactly K pending polls + 1 final success poll); emit as `BenchmarkResult`.
- [ ] 4.3 Assert `stage_duration_ms >= 0` and the stage exits cleanly (no throw).

## 5. Harness timeout descendant cleanup reliability test

- [ ] 5.1 Inject a fake harness `invoke` dep that simulates timeout by returning `{ timed_out: true, stdout: "", stderr: "", exit_code: null }` after a configurable delay (fake, no real subprocess).
- [ ] 5.2 Assert that after the fake timeout fires, the stage transitions to the `blocked` state (or equivalent timeout outcome) rather than advancing or throwing uncaught.
- [ ] 5.3 Add `// RED: fails without harness-descendant-cleanup fix because stage advances past a timed-out harness` comment. Verify manually that the test fails before the fix and passes after.

## 6. Partial GitHub transition failure reliability test

- [ ] 6.1 Build a fake `gh` dep that succeeds for `label list` and `pr comment create` but throws on `label add`; inject into the stage transition path.
- [ ] 6.2 Assert the stage sets outcome to `blocked` (does not silently advance with the wrong label) and records a `blocked_reason` containing "label".
- [ ] 6.3 Add `// RED: fails without partial-failure handling because stage advances despite label add error` comment. Verify manually.

## 7. Artifact corruption / missing file reliability test

- [ ] 7.1 Wire a fake artifact reader dep that returns `null` (missing file case); run the stage that reads `summary.json`; assert the stage surfaces a clear error state (not an uncaught throw and not a silent no-op).
- [ ] 7.2 Wire the same fake returning a non-JSON string (malformed case); assert the same outcome.
- [ ] 7.3 Add `// RED: fails without artifact-corruption guard because stage throws uncaught on null/bad JSON` comment. Verify manually.

## 8. Tests, CI, and docs

- [ ] 8.1 Run `npm test` from `core/`; all existing tests plus the new benchmark-reliability suite must pass green.
- [ ] 8.2 Confirm no real network, git, or subprocess calls are made by the suite (grep for `exec`, `spawn`, `fetch`, `ghRun` direct calls in the new test file — none should appear outside of injected fakes).
- [ ] 8.3 Run `npm run ci` from the repo root; confirm green (mirror check, smoke install).
- [ ] 8.4 Add a "Benchmark & Reliability Suite" section to the project README documenting: how to run (`cd core && npm test`), how to read the output (`BenchmarkResult` fields), and the six hotspot scenarios covered.
