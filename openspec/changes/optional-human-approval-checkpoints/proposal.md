## Why

Teams adopting the pipeline often want to start with narrower autonomy — letting the pipeline plan and review but requiring a human sign-off before implementation begins. Today there is no way to insert an explicit pause at a stage boundary; the pipeline runs end-to-end autonomously unless it encounters a blocker. This change adds optional, configurable human approval checkpoints so teams can graduate trust over time.

## What Changes

- A new `approval_checkpoints` config key (array of stage boundary names, default `[]`) in `.github/pipeline.yml`.
- When the pipeline is about to cross a declared boundary, it posts a checkpoint comment on the PR binding the current HEAD SHA, applies a `pipeline:awaiting-approval` label, and exits with `status: waiting` rather than advancing.
- Approval is granted by a human removing the `awaiting-approval` label (and optionally posting a comment) then re-invoking the pipeline; the pipeline verifies the checkpoint SHA still matches HEAD before continuing (stale-checkpoint detection).
- With `approval_checkpoints: []` (the default), behavior is identical to today: fully autonomous end-to-end.

## Capabilities

### New Capabilities

- `human-approval-checkpoints`: Config-driven pause points at stage boundaries; checkpoint comment + `awaiting-approval` label; SHA-bound staleness check; resume on label removal + re-invoke.

### Modified Capabilities

- `pipeline-configuration`: Adds `approval_checkpoints` array key to `PartialConfigSchema` and `DEFAULT_CONFIG`.
- `pipeline-state-machine`: Documents that `waiting` outcome now covers both CI-polling waits and human-approval waits; advance loop behavior is unchanged (stops on `waiting`).

## Impact

- `core/scripts/config.ts` — new `approval_checkpoints` field in schema + defaults.
- `core/scripts/stages/*.ts` — stage handlers that are valid checkpoint boundary sites (post-planning, post-plan-review, post-review-1, post-review-2) check if the current advance crosses a declared boundary before returning their advance result.
- `core/scripts/gh.ts` — add/remove `awaiting-approval` label helpers (reuse existing label wrappers).
- `core/scripts/pipeline.ts` — advance loop must recognize the `awaiting-approval` label at run start and surface a clear message rather than attempting to advance past a pending checkpoint.
- No changes to the review layer, eval gate, or pre-merge gate.
- Additive only; no existing behavior changes when `approval_checkpoints` is empty.
