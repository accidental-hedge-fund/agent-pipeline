## 1. CLI Plumbing

- [x] 1.1 Add `improve` case to the `pipeline.ts` CLI dispatch table, parsing `--apply`, `--top <N>`, `--since <date>`, `--min-occurrences <N>`, and `--json` flags
- [x] 1.2 Create `core/scripts/improve.ts` as the entry-point module; export a `runImprove(opts, deps)` function with a `Deps` seam for `gh`/filesystem fakes
- [x] 1.3 Add a `--help` description for `pipeline improve` consistent with the existing subcommand help style

## 2. Run Discovery

- [x] 2.1 Implement `discoverRuns(runsDir, since?)` — glob `.agent-pipeline/runs/*/events.jsonl`, read `run.json` for `started_at`, apply `--since` filter; include runs with missing `run.json`
- [x] 2.2 Write unit tests for `discoverRuns`: empty dir, missing `run.json`, `--since` exclusion, `--since` inclusion

## 3. Event Reading

- [x] 3.1 Implement streaming `readEventsLines(eventsJsonlPath)` — read events.jsonl line-by-line, skip corrupt/partial lines, return an async iterable of parsed event objects
- [x] 3.2 Write unit tests for `readEventsLines`: missing file returns empty, corrupt tail line is skipped, unknown fields are preserved

## 4. Clustering Engine

- [x] 4.1 Implement `normalizeSignal(str)` — lowercase, strip `#\d+` / `[0-9a-f]{7,40}` / `:\d+` tokens, collapse whitespace
- [x] 4.2 Implement `clusterReviewFindings(events, runId)` — extract `review_verdict` events, normalize finding titles, accumulate into a `Map<string, ClusterEntry>`
- [x] 4.3 Implement `clusterBlockers(events, runId)` — extract `blocker_set` events, normalize reason, accumulate into a `Map<string, ClusterEntry>`
- [x] 4.4 Implement `clusterFlakyGates(events, runId)` — extract `stage_complete` events with `outcome: "error"`, group by stage name
- [x] 4.5 Implement `clusterTokenWaste(summaryJson?)` — read optional `summary.json` for token/duration fields; skip silently if absent or schema mismatch
- [x] 4.6 Write unit tests for `normalizeSignal`: line-number stripping, SHA stripping, PR-number stripping, whitespace collapse
- [x] 4.7 Write unit tests for each cluster function: recurring signal is merged, distinct signals are separate clusters, evidence excerpt is ≤ 200 chars

## 5. Report Generation

- [x] 5.1 Implement `formatReport(clusters)` — human-readable Markdown-ish stdout output per the design spec format (category, signal, count, run IDs, excerpt, proposed issue title)
- [x] 5.2 Implement `formatJson(clusters)` — JSON array with `category`, `signal`, `count`, `runIds`, `excerpt` fields
- [x] 5.3 Add "token-waste skipped" note in both formats when that category had no data
- [x] 5.4 Write unit tests for `formatReport` and `formatJson`: empty cluster list, single cluster, token-waste-skipped note

## 6. Apply Mode

- [x] 6.1 Implement `applyIssues(clusters, opts, deps)` — filter clusters by `--min-occurrences`, take top-N, call `gh issue create` for each; record created issue URLs
- [x] 6.2 Ensure `applyIssues` calls no mutating gh commands other than `gh issue create`; guard with a compile-time-visible assertion in the Deps type
- [x] 6.3 Add `gh` authentication pre-check before issue creation loop; fail fast with descriptive error if not authenticated
- [x] 6.4 Attach created `issueUrl` to each cluster object in `--json` output when `--apply --json` are combined
- [x] 6.5 Write unit tests for `applyIssues`: qualifying clusters get `gh issue create` called, below-threshold clusters are skipped, top-N cap is respected, gh-not-authenticated path returns error

## 7. Memory Safety

- [x] 7.1 Audit `clusterReviewFindings`, `clusterBlockers`, `clusterFlakyGates` to confirm they accumulate only normalized keys + counts, not full event records
- [x] 7.2 Write a unit test that processes a synthetic run corpus of 500 events and asserts the in-memory cluster map contains ≤ distinct-key count entries (not 500)

## 8. Integration & CI

- [x] 8.1 Run `npm run ci` from repo root; fix any type or test failures
- [x] 8.2 Regenerate `plugin/` mirror with `node scripts/build.mjs` and verify `--check` passes
- [x] 8.3 Verify `pipeline improve --help` prints without error in a smoke test environment
