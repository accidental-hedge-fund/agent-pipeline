## 1. Config and Types

- [x] 1.1 Add `eval_gate` block type to `PipelineConfig` in `core/scripts/types.ts` (fields: `enabled`, `command`, `mode`, `timeout`, `max_attempts`)
- [x] 1.2 Add `eval_gate` default values to `DEFAULT_CONFIG` in `core/scripts/types.ts` (`enabled: false`, `mode: "gate"`, `timeout: 300`, `max_attempts: 2`)
- [x] 1.3 Add `eval_gate` Zod schema to `PartialConfigSchema` in `core/scripts/config.ts`
- [x] 1.4 Merge `eval_gate` file config into `PipelineConfig` inside `resolveConfig()` in `core/scripts/config.ts`

## 2. Stage Registration

- [x] 2.1 Insert `"eval-gate"` into the `STAGES` constant in `core/scripts/types.ts`, positioned after `"pre-merge"` and before `"ready-to-deploy"`
- [x] 2.2 Add `"eval-gate"` to the `dispatch()` switch in `core/scripts/pipeline.ts`, routing to the new eval stage handler

## 3. Eval Stage Module

- [x] 3.1 Create `core/scripts/stages/eval.ts` with an `advanceEval(cfg, issueNumber, opts)` function
- [x] 3.2 Implement the skip path: when `cfg.eval_gate.enabled` is false, transition to `ready-to-deploy` and return
- [x] 3.3 Implement the worktree resolution: use `getForIssue()` to obtain the worktree path; block with an error if no worktree is found
- [x] 3.4 Implement command execution: run `cfg.eval_gate.command` via `runCapped` (or equivalent) with the timeout from `cfg.eval_gate.timeout`, capturing stdout/stderr
- [x] 3.5 Implement retry loop: retry up to `cfg.eval_gate.max_attempts` times on non-zero exit or timeout; block with an "eval-gate errored" message after retries exhausted
- [x] 3.6 Implement the `## Eval Gate` comment: post pass/fail outcome, mode, elapsed time, and ≤2000-char stdout/stderr excerpt
- [x] 3.7 Implement gate routing: on pass → transition to `ready-to-deploy`; on fail + gate mode → call `setBlocked`; on fail + advisory mode → transition to `ready-to-deploy`

## 4. Tests

- [x] 4.1 Create `core/test/eval.test.ts` with unit tests covering:
  - skip path (disabled config → no command invoked, transitions forward)
  - exit 0 + gate mode → transitions to `ready-to-deploy`
  - non-zero exit + gate mode → `setBlocked` called, no forward transition
  - non-zero exit + advisory mode → comment posted, transitions to `ready-to-deploy`
  - retry on transient fail: first attempt fails, second passes → pass outcome
  - retries exhausted → `setBlocked` regardless of mode
  - timeout → treated as fail
- [x] 4.2 Add a state-machine test in `core/test/state-transitions.test.ts` asserting `eval-gate` is in `STAGES` between `pre-merge` and `ready-to-deploy`
- [x] 4.3 Add a config-parse test in `core/test/config.test.ts` asserting `eval_gate` block is parsed and defaults are applied correctly

## 5. Validation

- [x] 5.1 Run `pnpm test` and confirm all new and existing tests pass
- [x] 5.2 Run a dry-run pipeline invocation on a test issue in a repo with `eval_gate.enabled: false` and confirm the stage is skipped with no visible change
