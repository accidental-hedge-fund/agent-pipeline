## Why

Pipeline throughput has regressed because the current run artifacts collapse planning, plan-review, and implementation under a single misleading `planning` duration, and OpenSpec spec-delta drift is often discovered only at pre-merge after expensive review/fix loops. Operators need accurate stage timing and earlier deterministic blockers before tuning queue concurrency.

## What Changes

- Transition `pipeline:ready` items to `pipeline:planning` before any long-running planning work begins, and record separate lifecycle entries for `planning`, `plan-review`, and `implementing`.
- Reuse the existing conservative OpenSpec stale-delta guard in fix rounds before push, so real spec-divergence issues block before pre-merge.
- Record prompt-size telemetry in stage accounting without persisting raw prompts, and surface prompt size in scoreboard accounting output.
- Add a repo-local queue batch lock so overlapping `pipeline queue` invocations do not select and launch the same ready issues concurrently.
- Update documentation to describe `ready` as the queue entry point and the split long-running stages as the observable pipeline stages.

## Capabilities

### New Capabilities
- `queue-batch-safety`: Queue invocations are serialized with a repo-local lock to avoid duplicate batch launches.

### Modified Capabilities
- `pipeline-state-machine`: Long-running ready dispatch work is labelled and logged as `planning`, `plan-review`, and `implementing`, and OpenSpec stale-delta blockers can fire during fix rounds.
- `stage-cost-accounting`: Accounting records include sanitized prompt-size telemetry.
- `factory-scoreboard`: Scoreboard reports prompt-size telemetry alongside stage accounting groups.

## Impact

- Affected code: `core/scripts/pipeline-run.ts`, `core/scripts/stages/planning.ts`, `core/scripts/stages/fix.ts`, `core/scripts/stages/pre_merge.ts`, `core/scripts/harness.ts`, `core/scripts/accounting.ts`, `core/scripts/scoreboard.ts`, `core/scripts/stages/queue.ts`, shared types, tests, and README/OpenSpec docs.
- Public artifacts: additive optional fields in `stage_accounting` records; no raw prompt content is stored.
- Generated mirror: `plugin/` must be regenerated from `core/`.
