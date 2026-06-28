## 1. Artifact Reader

- [ ] 1.1 Add scoreboard domain types for run inputs, normalized run summaries, metric outputs, rate values, costs, and diagnostics.
- [ ] 1.2 Implement a run-store scanner that walks `.agent-pipeline/runs/*/` and reads `run.json`, `events.jsonl`, and `summary.json` without reading `terminal.log`.
- [ ] 1.3 Implement time-window parsing for `--since`, `--until`, and `--days`, including the 30-day default.
- [ ] 1.4 Resolve run start timestamps using `run.json.started_at`, then `run_start.at`, then run-id timestamp fallback.
- [ ] 1.5 Add diagnostic collection for missing run store, missing/corrupt artifacts, missing start time, missing PR on ready runs, and partial metric coverage.

## 2. Metric Aggregation

- [ ] 2.1 Normalize included runs into successful ready-to-deploy PR groups without double-counting duplicate summary/event records.
- [ ] 2.2 Compute ready-to-deploy-without-human-intervention rate from ready PRs, `human_intervention` events, and override records.
- [ ] 2.3 Compute full-run and per-stage wall-clock duration aggregates from lifecycle timestamps and `run_complete.elapsed_ms`.
- [ ] 2.4 Compute harness calls per successful PR from recorded harness invocation records.
- [ ] 2.5 Compute retry/fix-round counts per PR from fix-stage visits and explicit retry/recovery records.
- [ ] 2.6 Compute blocker-by-kind, needs-human, same-harness fallback, and test/eval/shipcheck pass-rate metrics.
- [ ] 2.7 Compute cost totals and cost per ready PR using actual `cost_usd`/`usage.cost_usd` fields or explicit `--estimate-cost` values.

## 3. CLI And Output

- [ ] 3.1 Add `pipeline scoreboard` as a no-issue-number CLI dispatch path with help text.
- [ ] 3.2 Add `--json`, `--since`, `--until`, `--days`, and repeatable `--estimate-cost <harness>=<usd-per-call>` parsing.
- [ ] 3.3 Implement the human-readable scoreboard formatter with all required metric headings and diagnostics.
- [ ] 3.4 Implement the JSON formatter as a single unfenced object containing `schema_version`, `window`, `totals`, `metrics`, and `diagnostics`.
- [ ] 3.5 Ensure scoreboard execution is read-only and does not call GitHub mutators or write run artifacts.

## 4. Tests

- [ ] 4.1 Add unit tests for scanner window filtering and run-start timestamp fallback order using fixture files.
- [ ] 4.2 Add unit tests covering every required metric with representative ready, blocked, needs-human, fallback, and gate-pass fixtures.
- [ ] 4.3 Add regression tests proving missing/corrupt artifacts and partial `events.jsonl` tails produce diagnostics rather than crashes.
- [ ] 4.4 Add unit tests for cost source precedence: actual cost wins, estimates fill missing actual cost, missing estimates make cost per ready PR unavailable.
- [ ] 4.5 Add CLI tests proving `--json` emits exactly one parseable object and the human output contains all metric headings.

## 5. Documentation And Verification

- [ ] 5.1 Document `pipeline scoreboard`, time-window flags, JSON output, diagnostics, and cost-estimate behavior in the README/help surface.
- [ ] 5.2 Run `node scripts/build.mjs` after core or host documentation edits and include regenerated `plugin/`.
- [ ] 5.3 Run `openspec validate factory-scoreboard`.
- [ ] 5.4 Run targeted core tests for the scoreboard implementation.
- [ ] 5.5 Run `npm run ci` from the repo root before marking implementation complete.
