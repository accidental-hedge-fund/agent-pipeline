## Why

The roadmap engine takes 15+ minutes on a ~9-issue backlog because every per-issue inventory harness call and every dependency-candidate verification call runs serially, making total latency proportional to `(issue count × per-call time) + (candidate count × per-call time)` rather than the parallel minimum. Operators cannot tell which phase is slow without adding instrumentation first.

## What Changes

- `plan.json` gains a `run_stats` top-level key recording per-phase timings (elapsed ms), harness call counts, and candidate counts so any run can be diagnosed from logs or the output file alone.
- `buildInventory` uses deterministic `extractCandidateFiles` first; the harness is called only when that extraction returns zero results (issue body is too ambiguous for regex heuristics). This eliminates most per-issue LLM calls on well-specified issues.
- Per-issue inventory harness calls that are still needed run with bounded concurrency (cap of `roadmap.inventory_concurrency`, default 4) instead of strictly serially.
- `buildDepgraph` deduplicates and ranks dependency candidates before source-verification and runs verification calls with bounded concurrency (cap of `roadmap.depgraph_concurrency`, default 4); low-confidence candidates that exceed a count cap are recorded in `open_questions[]` instead of being verified unconditionally.
- The `run_stats` object records counts of: open issues, filtered issues, inventory harness calls skipped (because regex succeeded), inventory harness calls made, dependency candidates by source (textual / shared-file / cross-file), dependency verification calls made, verification calls skipped due to cap, and critique rounds.
- `plan.json.run_stats` is included in the staleness-check surface so operators can tell whether a slow run is from stale config.

## Capabilities

### New Capabilities
- `roadmap-run-stats`: The `run_stats` field in `plan.json`, its schema, the phase-timing and call-count instrumentation, and the invariants that govern what is counted and when.

### Modified Capabilities
- `backlog-roadmap-engine`: Inventory harness call elision (regex-first), bounded-concurrency for inventory and depgraph verification calls, dependency-candidate deduplication and ranking before verification, cap-triggered `open_questions[]` recording for skipped candidates.

## Impact

- `core/scripts/roadmap/inventory.ts` — add regex-first path; add `InventoryDeps.runHarnessPool` or bounded-concurrency wrapper; emit harness-call counts to caller
- `core/scripts/roadmap/depgraph.ts` — deduplicate candidates before verification; add bounded-concurrency pool; add verification-cap logic; emit counts to caller
- `core/scripts/roadmap/index.ts` — add phase-timing wrappers; aggregate `run_stats`; include `run_stats` in `plan.json` write
- `core/scripts/roadmap/types.ts` — add `RunStats` type and `run_stats` field on `PlanJson`
- `core/test/` — new unit tests covering regex-first elision, concurrency-pool behaviour, candidate dedup/ranking, cap-triggered open_questions, and run_stats field correctness

## Acceptance Criteria

- [ ] A completed roadmap run emits a `run_stats` object in `plan.json` containing: `open_issue_count`, `filtered_issue_count`, `inventory_harness_calls`, `inventory_harness_skipped`, `depgraph_candidates_textual`, `depgraph_candidates_shared_file`, `depgraph_candidates_cross_file`, `depgraph_verify_calls`, `depgraph_verify_skipped`, `critique_rounds`, and `phase_elapsed_ms` (a record with one entry per named phase).
- [ ] A roadmap run over issues whose bodies contain unambiguous file references makes zero inventory harness calls for those issues (the regex path satisfies the lookup).
- [ ] A roadmap run over N issues where the regex path is insufficient makes at most `roadmap.inventory_concurrency` (default 4) concurrent inventory harness calls at any moment.
- [ ] Dependency verification calls for N candidates run at most `roadmap.depgraph_concurrency` (default 4) concurrently; candidates beyond `roadmap.depgraph_verify_cap` (default 20) are recorded in `plan.json.dependency_graph.open_questions[]` rather than being verified.
- [ ] No phase is skipped or short-circuited as a result of these changes; all 7 phases execute in order for every run.
- [ ] `plan.json` remains machine-readable with no new required top-level keys for existing consumers (all new keys are additive / optional in the schema).
- [ ] Unit tests cover regex-first elision, bounded concurrency, candidate dedup/ranking, cap-triggered open_questions, and run_stats correctness using injected fake deps — no real network, git, or subprocess calls.
