## Why

The `intake` and `sweep` sub-commands' harness calls fall through to `invoke()`'s 1200 s (20-minute) default timeout — a budget sized for multi-turn implementation stages. Because each sub-command makes exactly one harness call with no retry loop, a hung or slow endpoint burns the full 20 minutes before surfacing an error. This change adds configurable `intake_timeout` and `sweep_timeout` keys so operators can bound the hung-call failure mode to a defensively-sized but practical ceiling (~600 s).

## What Changes

- Add `intake_timeout` (default 600 s) and `sweep_timeout` (default 600 s) as top-level optional integer keys to `PartialConfigSchema` and `DEFAULT_CONFIG` in `config.ts`, following the same pattern as `implementation_timeout`, `review_timeout`, and `fix_timeout`.
- Thread `cfg.intake_timeout` through the `realIntakeDeps()` factory in `intake.ts` so the single `invoke()` call receives an explicit `timeoutSec`.
- Thread `cfg.sweep_timeout` through the `realSweepDeps()` factory in `sweep.ts` so the single `invoke()` call receives an explicit `timeoutSec`.
- Expose the `timeoutSec` parameter in the `IntakeDeps.runHarness` and `SweepDeps.runHarness` signatures so unit tests can assert it is forwarded correctly.
- Update the `pipeline config --init` template in `config.ts` to document the two new keys.

## Capabilities

### New Capabilities

_(none — this change adds configuration keys to an existing capability, not a new capability surface)_

### Modified Capabilities

- `pipeline-configuration`: The config schema gains two new optional integer keys (`intake_timeout`, `sweep_timeout`) with specified defaults and a minimum value of 1. `resolveConfig()` SHALL merge them with the same precedence rule (CLI > file > default) as existing timeout keys.
- `intake-sub-command`: The `runHarness` dep SHALL accept and forward a per-call wall-clock timeout; the real dep factory SHALL pass `cfg.intake_timeout` to `invoke()` instead of relying on `invoke()`'s implicit 1200 s default.
- `sweep-sub-command`: The `runHarness` dep SHALL accept and forward a per-call wall-clock timeout; the real dep factory SHALL pass `cfg.sweep_timeout` to `invoke()` instead of relying on `invoke()`'s implicit 1200 s default.

## Impact

- `core/scripts/config.ts` — schema additions (`intake_timeout`, `sweep_timeout`), DEFAULT_CONFIG entries, `resolveConfig()` merge lines, `--init` template.
- `core/scripts/stages/intake.ts` — `IntakeDeps.runHarness` signature, `realIntakeDeps()` factory, `runIntake()` plumbing.
- `core/scripts/stages/sweep.ts` — `SweepDeps.runHarness` signature, `realSweepDeps()` factory, `runSweep()` plumbing.
- `core/test/config.test.ts` — regression tests for the two new keys (schema acceptance, default values, merge precedence).
- `core/test/intake.test.ts` — regression test asserting `timeoutSec` is forwarded.
- `core/test/sweep.test.ts` — regression test asserting `timeoutSec` is forwarded.
- `plugin/` mirror — regenerated after core changes.

## Acceptance Criteria

- [ ] `intake_timeout` and `sweep_timeout` are accepted by the config schema; an invalid value (non-integer, ≤ 0) causes `resolveConfig()` to throw.
- [ ] When `.github/pipeline.yml` omits both keys, the resolved values are 600 s each.
- [ ] When `.github/pipeline.yml` sets `intake_timeout: 300`, the resolved value is 300 s (file overrides default).
- [ ] The intake harness call passes `timeoutSec: cfg.intake_timeout` to `invoke()`; a fake dep in unit tests can observe this value.
- [ ] The sweep harness call passes `timeoutSec: cfg.sweep_timeout` to `invoke()`; a fake dep in unit tests can observe this value.
- [ ] No existing timeout behavior for other stages (implementation, review, fix, CI, last30days, test_gate, eval_gate) is changed.
- [ ] `npm run ci` passes end-to-end after the change.
