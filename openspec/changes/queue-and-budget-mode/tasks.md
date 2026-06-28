## 1. CLI dispatch wiring

- [ ] 1.1 Add `queue` to the recognized no-issue-number keyword list in `pipeline.ts`; detect it in the dispatch block alongside `sweep`, `release`, `intake`, `roadmap`, `triage`, `merge`, `refine-spec`, and `scoreboard`.
- [ ] 1.2 Define CLI flags for queue mode: `--max-issues <N>` (default: 10), `--budget-dollars <D>` (default: unlimited), `--concurrency <C>` (default: 1), `--max-failure-rate <R>` (default: 1.0, 0.0–1.0), `--label <L>` (repeatable), `--milestone <M>`, `--risk <low|medium|high>`.
- [ ] 1.3 Import `runQueue` from `./stages/queue.ts` and call it in the early-dispatch block, mirroring the `sweep` and `release` patterns.
- [ ] 1.4 Update argument description string and help text to list `queue` alongside peer sub-commands.

## 2. `QueueDeps` interface and `realQueueDeps()`

- [ ] 2.1 Define `QueueDeps` in `queue.ts`: `listEligibleIssues(filters: IssueFilters): Promise<EligibleIssue[]>`, `runPipeline(issueNumber: number, opts: RunOpts): Promise<RunResult>`, `readRunCost(issueNumber: number): Promise<number | null>`, `writeFile(path: string, content: string): Promise<void>`, `log(msg: string): void`, `clock(): number` (returns epoch ms; injectable for testing).
- [ ] 2.2 Define `IssueFilters` type: `{ labels?: string[], milestone?: string, risk?: 'low' | 'medium' | 'high' }`.
- [ ] 2.3 Define `EligibleIssue` type: `{ number: number, title: string, labels: string[], priorityScore: number }`.
- [ ] 2.4 Define `RunResult` type: `{ issueNumber: number, finalState: string, costUsd: number | null, durationMs: number, error?: string }`.
- [ ] 2.5 Implement `realQueueDeps()` wiring: `listEligibleIssues` via `gh issue list --json` filtered to autonomous-eligible labels, `runPipeline` via child-process spawn of the pipeline CLI for the given issue number, `readRunCost` via reading `.agent-pipeline/runs/<issue>/run.json` or `summary.json`, `writeFile` via `fs.writeFile`, `clock` via `Date.now`.

## 3. Issue selection and ranking

- [ ] 3.1 Implement `selectIssues(candidates: EligibleIssue[], filters: IssueFilters, maxIssues: number): EligibleIssue[]` — apply label, milestone, and risk filters then return the top-`maxIssues` items sorted by `priorityScore` descending.
- [ ] 3.2 Define `priorityScore` as a deterministic function of label state (e.g. issues with `pipeline:ready` score higher than `pipeline:review-2`). Document the scoring formula as a constant in `queue.ts` so it is auditable and testable without a model call.
- [ ] 3.3 Add unit tests for `selectIssues`: no candidates returns empty list; label filter excludes non-matching issues; `maxIssues` cap is respected; priority ordering is stable.

## 4. Concurrency-bounded dispatch loop

- [ ] 4.1 Implement the dispatch loop in `runQueue`: maintain an active-slot set (`Map<number, Promise<RunResult>>`); while selected issues remain and slots are available (`activeSlots.size < concurrency`), fill a slot by calling `deps.runPipeline`; when a slot resolves, remove it, record the outcome, and check guards before filling the next slot.
- [ ] 4.2 Wrap each `deps.runPipeline` call in try/catch; on exception record the outcome as `{ finalState: 'error', costUsd: null, durationMs: ..., error: e.message }` and treat it as a failed run for the failure-rate calculation.
- [ ] 4.3 After each slot completes, accumulate `costUsd` into `cumulativeCostUsd` (reading from `deps.readRunCost` if `costUsd` is null in the result).

## 5. Budget enforcement

- [ ] 5.1 Before filling a new slot, check `cumulativeCostUsd >= budgetDollars`; if so, log a budget-exhausted notice and stop launching new issues.
- [ ] 5.2 After the budget cap is hit, let all in-flight slots complete before writing the summary.
- [ ] 5.3 Add unit tests for budget enforcement: cumulative cost reaches cap mid-batch; remaining issues are not launched; in-flight runs finish.

## 6. Failure-rate gate

- [ ] 6.1 After each slot completes, compute `failureRate = failedCount / completedCount` (where `failed` = any `finalState` that is not `ready-to-deploy` and not `needs-human`).
- [ ] 6.2 If `completedCount >= 3` and `failureRate >= maxFailureRate`, log a failure-rate-exceeded notice and stop launching new issues; let in-flight runs finish.
- [ ] 6.3 Add unit tests for the failure-rate gate: fewer than 3 completed runs do not trigger the gate even if all fail; at 3 completed runs the gate fires at the configured threshold; in-flight runs complete after the gate fires.

## 7. Batch summary artifact

- [ ] 7.1 Implement `buildBatchSummary(results: RunResult[], opts: QueueOpts, startedAt: number, endedAt: number): BatchSummary`.
- [ ] 7.2 Define `BatchSummary` type with fields: `schema_version: "1"`, `batch_id: string`, `started_at: string` (ISO 8601), `ended_at: string`, `issues: PerIssueSummary[]`, `aggregate: { total_issues: number, succeeded: number, failed: number, failure_rate: number, total_cost_usd: number, total_duration_ms: number }`, `limits: { max_issues: number, budget_dollars: number | null, concurrency: number, max_failure_rate: number }`.
- [ ] 7.3 Define `PerIssueSummary` type: `{ number: number, title: string, final_state: string, cost_usd: number | null, duration_ms: number, error?: string }`.
- [ ] 7.4 Write `batch-summary.json` to `.agent-pipeline/runs/batch-<batch_id>/batch-summary.json` via `deps.writeFile`.
- [ ] 7.5 Print the human-readable summary to stdout (per-issue table + aggregate line + artifact path).
- [ ] 7.6 Add unit tests: `buildBatchSummary` produces valid JSON matching the schema; file is written to the correct path; stdout includes per-issue rows and aggregate.

## 8. Config schema extension

- [ ] 8.1 Extend `PartialConfigSchema` in `config.ts` to accept a `queue:` sub-key with fields: `max_issues` (number), `budget_dollars` (number | null), `concurrency` (number), `max_failure_rate` (number, 0.0–1.0).
- [ ] 8.2 CLI flags take precedence over config values, which take precedence over built-in defaults. Document precedence in a comment above the merge logic.
- [ ] 8.3 Add unit test: valid `queue:` config is accepted; unknown key triggers a strict-schema parse error; `max_failure_rate` outside [0, 1] is rejected.

## 9. Unit tests (`core/test/queue.test.ts`)

- [ ] 9.1 Happy-path batch: 5 eligible issues, concurrency 2, all succeed; summary written with correct counts and aggregate cost.
- [ ] 9.2 `--max-issues` cap: 10 eligible issues, `--max-issues 3`; only 3 runs launched.
- [ ] 9.3 Budget exhaustion mid-batch: runs 1–3 each cost $0.40, budget $1.00; run 4 is not launched; summary records budget-exhausted halt.
- [ ] 9.4 Failure-rate gate: 3 completed runs, 2 failed (rate 0.67); `--max-failure-rate 0.5`; run 4 is not launched; in-flight run 5 (already started before gate) completes normally.
- [ ] 9.5 Gate cold-start: 2 completed runs, both failed; gate does NOT fire (sample too small); run 3 is launched.
- [ ] 9.6 Per-issue isolation: run 2 throws an uncaught error; runs 1, 3 complete normally; summary records run 2 as `error` without aborting the batch.
- [ ] 9.7 Label filter: 6 eligible issues, 2 have `risk:high`; `--risk medium` excludes the 2 high-risk issues; 4 remain.
- [ ] 9.8 Config sub-key defaults: `queue.concurrency: 3` in config + no `--concurrency` flag → effective concurrency is 3.
- [ ] 9.9 Config CLI override: `queue.concurrency: 3` in config + `--concurrency 1` flag → effective concurrency is 1.
- [ ] 9.10 `buildBatchSummary` serializes to valid JSON; `JSON.parse` succeeds; `schema_version` is `"1"`.

## 10. Documentation

- [ ] 10.1 Add `queue` to the sub-command table in `README.md` with all flags, their defaults, and example invocations (dry-run, budget cap, failure gate).
- [ ] 10.2 Add `queue` to `hosts/claude/SKILL.md` (usage line + example).
- [ ] 10.3 Document the `batch-summary.json` schema and its path convention in `README.md`.

## 11. Mirror + CI

- [ ] 11.1 `node scripts/build.mjs`; verify mirror is in sync.
- [ ] 11.2 `npm run ci` green end-to-end.
