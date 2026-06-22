## Context

`buildInventory` currently calls `deps.runHarness(prompt)` for **every** filtered issue in a sequential `for` loop (`inventory.ts:115-125`). A backup path (`extractCandidateFiles`) already exists for when the harness fails, but is never used proactively — even when the issue body contains unambiguous file references. `buildDepgraph` similarly calls `runHarness` per candidate pair sequentially (`depgraph.ts:buildDepVerifyPrompt` call sites). `runRoadmap` emits phase-start log lines but records no timing or counts in `plan.json`.

## Goals / Non-Goals

**Goals:**
- Add `run_stats` to `plan.json` so any run can be diagnosed without re-running
- Eliminate redundant inventory harness calls via regex-first elision
- Add bounded concurrency for remaining inventory and depgraph-verification calls
- Cap unbounded candidate verification with visible `open_questions[]` entries

**Non-Goals:**
- Caching plan.json across runs (tracked separately; out of this scope)
- Changing the scoring, tiering, or critique algorithms
- Reducing critique harness calls (critique already runs ≤2 times; not the bottleneck)
- Making `--apply` write-backs faster
- Any changes to `plugin/` beyond regenerating the mirror

## Decisions

### Decision 1: Regex-first elision threshold

When `extractCandidateFiles` returns ≥1 result, the inventory phase uses those results directly and skips the harness call. When it returns 0 (ambiguous issue body with no detectable file paths), the harness is called as before. This is a pure latency optimization — the fallback path is unchanged.

**Rationale:** The existing `extractCandidateFiles` regex already covers the common case (backtick-wrapped paths, `.ts`/`.md`/`.yml` extensions). A false-positive regex match is no worse than today's harness inference, which is also heuristic. The harness adds value for truly ambiguous text like "the config system should validate release_model" with no file names; that case still hits the harness.

### Decision 2: Bounded concurrency via a simple async pool, not a framework dep

Implement a minimal `runPool<T>(tasks, concurrency)` utility function in a new `core/scripts/roadmap/pool.ts` that processes an array of `() => Promise<T>` thunks with a sliding-window concurrency cap. No external dependency. This matches the codebase's existing pattern of no-build, no-framework, injectable I/O.

### Decision 3: Depgraph concurrency cap and verification cap as config keys

Expose `roadmap.inventory_concurrency` (default 4), `roadmap.depgraph_concurrency` (default 4), and `roadmap.depgraph_verify_cap` (default 20) in `PartialConfigSchema`. All three are optional with documented defaults; existing repos gain the optimized behaviour with no config changes. The cap and concurrency values are implementation knobs — they do not change the spec-level requirement that all unverified candidates that exceed the cap are visible in `open_questions[]`.

**Rationale for cap 20:** For 9 issues the textual + shared-file + cross-file candidate count is bounded by `O(N²)` ≈ 72 pairs. Verifying all 72 pairs at concurrency 4 still runs in ~18 parallel rounds of 4 calls each. Capping at 20 means the top-20 ranked candidates are verified (candidate ranking is described in Decision 4) and the remainder go to `open_questions[]`, which is a visible, recoverable state — not silent truncation.

### Decision 4: Candidate ranking before the verification cap is applied

Before applying the `depgraph_verify_cap`, candidates are ranked:
1. Textual candidates first (issue body explicitly names a dependency — strongest signal)
2. Shared-file candidates second (both issues touch the same file — medium signal)
3. Cross-file candidates last (only cross-file import inference — weakest, most speculative)

Within each group, candidates are ordered by combined touched-file count (more overlap = higher priority). This ensures the cap removes the least-informative candidates, not random ones.

### Decision 5: `run_stats` is additive in `plan.json`, not a breaking change

`run_stats` is added as a new optional top-level key in `PlanJson`. Existing `plan.json` readers that only access `roadmap[]`, `dependency_graph`, etc. are unaffected. The `backlog-roadmap-engine` spec already requires `plan.json` to contain `generated_at` and `backlog_sha`; `run_stats` extends that pattern without replacing any key.

### Decision 6: Phase timings use `Date.now()` in production, injectable in tests

Each phase wrapper records `start = deps.now()` before and `end = deps.now()` after. `deps.now` defaults to `() => Date.now()` in production and is set to a monotonic counter in tests (avoiding the `Date.now()` ban in workflow scripts; this is production TypeScript, not a workflow script, so `Date.now()` is fine here). The injected `now` is added to `RoadmapDeps` with a default.

## Risks / Trade-offs

- [Risk] Regex-first elision could produce a shorter or differently-ordered `touched_files[]` than the harness would, changing depgraph candidate sets. → Mitigation: `extractCandidateFiles` is already the harness fallback path and is already in use on harness failures; any difference is within the existing tolerance. `run_stats.inventory_harness_skipped` makes the elision count auditable.
- [Risk] Bounded concurrency requires coordinating multiple in-flight harness calls. Harness implementations that are not re-entrant could misbehave. → Mitigation: the existing harness is stateless (subprocess-per-call); the pool issues N simultaneous subprocesses. The pool cap prevents OOM from too many concurrent subprocesses.
- [Risk] The `depgraph_verify_cap` silently skips low-ranked candidates. → Mitigation: every skipped candidate is recorded in `open_questions[]` with its rank and reason; `run_stats.depgraph_verify_skipped` makes the count visible at the top level. This is not silent truncation.

## Open Questions

1. **Persistent cache** — Should inventory results be cached keyed by `backlog_sha` across runs? Tracked as a separate issue; out of this scope. `run_stats` makes the cost visible so the cache decision can be data-driven.
2. **Critique concurrency** — The critique phase already runs ≤2 rounds and is a single harness call per round; no concurrency optimization needed here.
