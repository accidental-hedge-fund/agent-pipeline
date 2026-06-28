## Why

The pipeline is issue-centric: a human selects one issue and drives it forward. A software factory needs a control-plane mode — select the best ready work from the backlog, run bounded batches, pause when the failure rate spikes, and expose progress and costs to operators and Pipeline Desk without scraping prose logs.

## What Changes

- Add `queue` as a new no-issue-number positional sub-command keyword accepted by the pipeline CLI (alongside `sweep`, `intake`, `release`, `roadmap`, etc.).
- Add `core/scripts/stages/queue.ts` implementing the sub-command handler with injectable I/O deps (same seam pattern as `release.ts`, `intake.ts`, `sweep.ts`).
- The handler selects eligible issues from the live GitHub backlog (only those already cleared for autonomous work via label), applies caller-specified filters (label, release milestone, risk class), ranks them by priority score, and starts up to `--concurrency` parallel pipeline runs respecting an explicit `--budget-dollars` cap.
- Before starting each additional issue, the handler checks: budget remaining, failure rate so far, and concurrency slots available. If the failure rate crosses `--max-failure-rate`, it stops launching new issues and waits for in-flight runs to finish.
- Each run is isolated: a failure in one issue's pipeline run is recorded and reported without cancelling or corrupting in-flight runs on other issues.
- After all runs finish (or the batch is halted), the handler writes a machine-readable `batch-summary.json` to the run directory and prints a structured text summary to stdout.
- Existing single-issue invocation (`pipeline <N>`) is unchanged. The autonomous loop does not merge PRs.

## Capabilities

### New Capabilities
- `batch-queue-engine`: The `queue` no-issue-number sub-command — issue selection, filter/rank, concurrency-bounded parallel dispatch, budget enforcement, failure-rate gating, and machine-readable batch summary artifact.

### Modified Capabilities
- `pipeline-state-machine`: The CLI positional-argument dispatch block gains `queue` as a recognized keyword that requires no issue number and advances no stage label; it MUST be listed in the help text alongside other no-issue-number modes.

## Impact

- `core/scripts/pipeline.ts` — dispatch block, help text, flag definitions (`--max-issues`, `--budget-dollars`, `--concurrency`, `--max-failure-rate`, `--label`, `--milestone`, `--risk`).
- `core/scripts/stages/queue.ts` — new file (sub-command handler + injectable `QueueDeps` interface).
- `core/scripts/config.ts` — optional `queue:` config sub-key for operator defaults.
- `core/test/queue.test.ts` — unit tests for the new stage.
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` / `hosts/claude/SKILL.md` — document the new sub-command and all flags.

## Acceptance Criteria

- [ ] `pipeline queue` is accepted by the CLI without an issue number and dispatches the queue handler; unrecognized usage produces a clear error listing recognized sub-commands including `queue`.
- [ ] Only issues already eligible for autonomous pipeline work (as determined by label state) enter the batch; issues in a non-autonomous state are excluded and counted in the summary.
- [ ] `--max-issues N` caps the number of issues started in the batch; no more than N issues receive a pipeline run regardless of backlog size.
- [ ] `--budget-dollars D` stops launching new issues once cumulative run cost (summed from `run.json` cost fields across completed batch runs) is projected to exceed `D`; the check occurs before each new issue is dispatched.
- [ ] `--concurrency C` limits how many issue pipeline runs execute in parallel; no more than C runs are active simultaneously.
- [ ] `--max-failure-rate R` (0.0–1.0) halts new issue launches when the ratio of failed-to-completed runs exceeds R; in-flight runs are allowed to complete.
- [ ] `--label L`, `--milestone M`, and `--risk {low|medium|high}` filter the eligible issue set before selection; the summary reports how many issues were excluded by each filter.
- [ ] A failure in one issue's pipeline run does not cancel or corrupt in-flight runs for other issues; the batch continues.
- [ ] A `batch-summary.json` artifact is written to the run directory after the batch finishes; its schema includes: batch ID, start/end timestamps, issue outcomes (per-issue: number, title, final state, cost, duration), aggregate metrics (total cost, total duration, throughput, failure rate), and a `schema_version` field.
- [ ] The batch summary is also printed to stdout in human-readable form at the end of the run.
- [ ] Pipeline Desk can consume `batch-summary.json` without parsing prose logs.
- [ ] The autonomous loop does not merge any PR during queue mode.
- [ ] All new logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests).
- [ ] `npm run ci` passes end-to-end after the change.
