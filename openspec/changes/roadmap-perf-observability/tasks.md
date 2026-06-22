## 1. Types

- [ ] 1.1 Add `RunStats` interface to `core/scripts/roadmap/types.ts` with all required sub-fields: `open_issue_count`, `filtered_issue_count`, `inventory_harness_calls`, `inventory_harness_skipped`, `depgraph_candidates_textual`, `depgraph_candidates_shared_file`, `depgraph_candidates_cross_file`, `depgraph_verify_calls`, `depgraph_verify_skipped`, `critique_rounds`, `phase_elapsed_ms`
- [ ] 1.2 Add `run_stats?: RunStats` field to `PlanJson` interface in `types.ts`
- [ ] 1.3 Add `inventory_concurrency`, `depgraph_concurrency`, and `depgraph_verify_cap` optional fields to `RoadmapConfig` in `types.ts`
- [ ] 1.4 Add `now?: () => number` to `RoadmapDeps` (injectable clock, defaults to `Date.now`)

## 2. Config Schema

- [ ] 2.1 Add `inventory_concurrency: z.number().int().positive().optional()`, `depgraph_concurrency: z.number().int().positive().optional()`, and `depgraph_verify_cap: z.number().int().positive().optional()` to the `roadmap:` sub-schema in `config.ts`
- [ ] 2.2 Add unit test: valid values are accepted; absent keys produce defaults of 4/4/20 at usage sites; non-integer or non-positive values are rejected

## 3. Concurrency Pool Utility

- [ ] 3.1 Implement `runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]>` in a new file `core/scripts/roadmap/pool.ts`
- [ ] 3.2 Add unit tests for `runPool`: preserves input order in results, caps concurrency to the given limit, handles empty input, propagates rejections

## 4. Inventory — Regex-First Elision + Bounded Concurrency

- [ ] 4.1 Modify `buildInventory` in `inventory.ts`: for each issue call `extractCandidateFiles(issue)` first; if result is non-empty, skip the harness call and record `skipped++`; if empty, queue a harness call
- [ ] 4.2 Process queued harness calls through `runPool` with `config.inventory_concurrency ?? 4`
- [ ] 4.3 Return harness-call count and skipped count from `buildInventory` (add to return type or pass a `stats` accumulator object)
- [ ] 4.4 Add unit tests: well-specified issue (has file paths) produces no harness call; ambiguous issue produces harness call; multiple ambiguous issues run concurrently up to cap; skipped count equals number of regex-satisfying issues

## 5. Depgraph — Candidate Deduplication, Ranking, Cap, and Bounded Concurrency

- [ ] 5.1 Extract all candidate pairs (textual + shared-file + cross-file) into a single list tagged by source before any verification calls
- [ ] 5.2 Deduplicate the candidate list (same from/to pair from multiple sources → keep the highest-priority source tag)
- [ ] 5.3 Sort candidates: textual first, then shared-file, then cross-file; within each group sort descending by overlapping touched-file count
- [ ] 5.4 Apply `depgraph_verify_cap` (default 20): candidates beyond the cap are added to `open_questions[]` with rationale "candidate ranked beyond verify cap" and counted in `verify_skipped`
- [ ] 5.5 Run verification on the capped candidate list using `runPool` with `config.depgraph_concurrency ?? 4`
- [ ] 5.6 Return call count and skipped count from `buildDepgraph` for inclusion in `run_stats`
- [ ] 5.7 Add unit tests: deduplication collapses same-pair from two sources; ranking order is textual→shared-file→cross-file; cap triggers open_questions entries; concurrent verification is bounded; skipped count is correct

## 6. Phase Timing and run_stats Assembly

- [ ] 6.1 In `runRoadmap`, add phase timing wrappers around each of the 7 phases using `deps.now ?? Date.now`; accumulate `phase_elapsed_ms` for each named phase
- [ ] 6.2 Assemble `run_stats` from: `open_issue_count` (from `getOpenIssues` result), `filtered_issue_count` (from `filterIssues` result), inventory stats (from step 4.3), depgraph stats (from step 5.6), `critique_rounds` (existing counter), and `phase_elapsed_ms`
- [ ] 6.3 Pass `run_stats` to `writePlanJson` and include it as `plan.json.run_stats`
- [ ] 6.4 Add unit test: `run_stats` present and correct after a simulated run with fake deps; `open_issue_count ≥ filtered_issue_count`; `inventory_harness_calls + inventory_harness_skipped === filtered_issue_count`

## 7. CI Gate

- [ ] 7.1 Run `npm run ci` from the repo root and confirm all tests pass (core suite + mirror-sync check)
- [ ] 7.2 Regenerate `plugin/` mirror via `node scripts/build.mjs` and include in the same commit
