## Context

The pipeline CLI has multiple no-issue-number sub-commands following a stable pattern (`release.ts`, `intake.ts`, `sweep.ts`, `triage.ts`): a positional keyword is detected early in the dispatch block, a dedicated `stages/<name>.ts` handler is imported and called, and all external I/O is injected via a `<Name>Deps` interface so unit tests run without network, git, or subprocess calls.

The `factory-scoreboard` sub-command (issue #301) is a read-only reporting layer over past run artifacts. The `bounded-auto-loop` spec (issue #186) adds per-issue recovery continuations within a single run. The `queue` sub-command is the *control-plane* layer: it selects, schedules, and dispatches *multiple* issue runs in a bounded batch, then summarizes the results. These are distinct concerns with no shared implementation surface.

Stage-level cost accounting (issue #304) adds `stage_cost` records to `run.json` and `summary.json`. The queue handler reads those accumulated cost fields from completed batch runs to enforce the budget cap.

## Goals / Non-Goals

**Goals:**
- A `queue` sub-command that selects eligible issues, applies user-specified filters, and launches bounded parallel pipeline runs.
- Hard limits on concurrency, max-issue count, and cumulative cost (via `--budget-dollars`).
- A failure-rate gate that halts new launches when the observed failure ratio exceeds the threshold.
- Full isolation between per-issue runs: one failure must not corrupt or cancel others.
- A machine-readable `batch-summary.json` artifact suitable for Pipeline Desk consumption.
- Injectable deps throughout — no real network, git, or subprocess in unit tests.

**Non-Goals:**
- Merging any PR — the never-auto-merge guarantee is preserved in queue mode.
- Real-time token counting — budget is enforced via post-run cost fields from `run.json`, not live token streams.
- Dynamic priority re-ranking mid-batch — the ranked list is computed once before dispatch.
- Interactive prompting — the command is fully non-interactive.

## Decisions

**Decision: `queue` follows the exact same dispatch-and-injectable-deps pattern as `sweep`/`release`.**
There is no reason to introduce a new structural pattern. The `QueueDeps` interface covers: `listEligibleIssues`, `runPipeline` (spawns a single-issue run and returns a result), `readRunCost` (reads cost from a completed run's `run.json`), `writeFile`, `log`, and `clock` (for timestamps). `realQueueDeps()` wires each to real process spawning and filesystem operations.

**Decision: eligibility is determined by label, not re-evaluated by the queue handler.**
The queue handler calls `deps.listEligibleIssues(filters)` which fetches issues with labels in the autonomous-eligible set (e.g. `pipeline:ready`, or whichever label class the operator designates). Re-evaluating eligibility would require the queue handler to understand stage semantics — that is already owned by the per-issue advance loop. The handler treats label-gated eligibility as the single source of truth, and the filter flags (`--label`, `--milestone`, `--risk`) narrow the eligible set further.

**Decision: concurrency via a simple counting semaphore, no worker pool framework.**
The maximum batch size is bounded by `--max-issues` (default: 10, configurable). A plain `Promise.all`-with-slot tracking loop is sufficient and keeps the implementation free of external concurrency libraries. Each slot tracks: `{ issueNumber, promise, startedAt }`. When a slot resolves, the handler checks failure rate, budget, and remaining issues before filling the slot.

**Decision: budget enforcement is post-run, not pre-run.**
Real-time token counting requires access to the streaming cost APIs of each harness, which is not available without tight coupling to the harness implementation. Instead, the handler reads the `total_cost_usd` field from the completed run's `run.json` (written by the cost-accounting layer from issue #304) and accumulates it. Before launching a new issue, the handler checks whether the accumulated cost has reached `--budget-dollars`. This is conservative — a run already in flight is not killed when the budget is reached; only new launches are blocked.

**Decision: failure rate is computed over completed runs only.**
In-flight runs are not counted in the denominator until they complete. The failure rate gate fires when `failedCount / completedCount ≥ max-failure-rate`. This avoids a race where a transient early failure triggers an over-aggressive halt at low sample sizes. As a guard, the halt is not triggered until at least 3 issues have completed.

**Decision: `batch-summary.json` schema is versioned from day one.**
The summary artifact is a first-class Pipeline Desk interface. A `schema_version: "1"` field ensures forward compatibility; Pipeline Desk can reject or adapt on version mismatch. The envelope structure mirrors the `run.json` / `summary.json` conventions already in the codebase.

**Decision: defaults for all limits are set in `queue:` config sub-key, overridable by flags.**
Operators can set `queue.max_issues`, `queue.budget_dollars`, `queue.concurrency`, and `queue.max_failure_rate` in `.github/pipeline.yml`. CLI flags take precedence over config values, which take precedence over built-in defaults. This allows Pipeline Desk to configure a consistent batch policy without requiring flags on every invocation.

## Risks / Trade-offs

- *Budget enforcement is post-run* → A run can finish with a cost that overshoots the budget cap if it was already in flight. Mitigation: the overshoot is bounded by `--concurrency` simultaneous runs. For strict cost caps, operators should set concurrency to 1.
- *Failure-rate gate has a cold-start period* → With the minimum sample size of 3, the gate cannot trigger on a batch of 1 or 2 issues. This is intentional — a single failure should not abort a batch.
- *No mid-batch priority re-ranking* → If the issue set changes while the batch runs (new labels applied), the batch does not adapt. Re-ranking mid-batch would complicate concurrency control and is out of scope for this change.
- *Process isolation for per-issue runs* → If `deps.runPipeline` spawns a child process, an uncaught fatal in that process must not crash the queue handler. The handler wraps each `runPipeline` call in a try/catch and records the outcome as `error` rather than propagating.
