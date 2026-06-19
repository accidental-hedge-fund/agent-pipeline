## 1. Config schema additions (`config.ts`)

- [ ] 1.1 Add `intake_timeout: z.number().int().positive().optional()` and `sweep_timeout: z.number().int().positive().optional()` to `PartialConfigSchema` (alongside `implementation_timeout`, `review_timeout`, `fix_timeout`).
- [ ] 1.2 Add `intake_timeout: 600` and `sweep_timeout: 600` to `DEFAULT_CONFIG`.
- [ ] 1.3 Add `intake_timeout: fileConfig.intake_timeout ?? DEFAULT_CONFIG.intake_timeout` and `sweep_timeout: fileConfig.sweep_timeout ?? DEFAULT_CONFIG.sweep_timeout` to the `resolveConfig()` merge block.
- [ ] 1.4 Add `intake_timeout` and `sweep_timeout` to the `PipelineConfig` type (or its source type, if inferred from the schema).
- [ ] 1.5 Add documentation lines for both keys to the `--init` config template string.

## 2. `intake.ts` wiring

- [ ] 2.1 Extend the `IntakeDeps.runHarness` signature to accept a `timeoutSec: number` parameter: `runHarness(prompt: string, timeoutSec: number): Promise<{ success: boolean; output: string }>`.
- [ ] 2.2 Update `realIntakeDeps()` to accept `cfg: Pick<PipelineConfig, 'models' | 'intake_timeout'>` (or the resolved timeout directly) and pass `{ stream: true, model, lean: true, timeoutSec: intakeTimeout }` to `invoke()`.
- [ ] 2.3 Update the `runIntake()` call site to forward `timeoutSec: cfg.intake_timeout` when invoking `d.runHarness`.
- [ ] 2.4 Update call sites in `pipeline.ts` that construct `realIntakeDeps()` to pass the resolved config timeout.

## 3. `sweep.ts` wiring

- [ ] 3.1 Extend the `SweepDeps.runHarness` signature to accept a `timeoutSec: number` parameter: `runHarness(prompt: string, timeoutSec: number): Promise<{ success: boolean; output: string }>`.
- [ ] 3.2 Update `realSweepDeps()` to accept the resolved sweep timeout and pass `{ stream: true, model, lean: true, timeoutSec: sweepTimeout }` to `invoke()`.
- [ ] 3.3 Update the `runSweep()` call site to forward `timeoutSec: cfg.sweep_timeout` when invoking `d.runHarness`.
- [ ] 3.4 Update call sites in `pipeline.ts` that construct `realSweepDeps()` to pass the resolved config timeout.

## 4. Unit tests

- [ ] 4.1 `core/test/config.test.ts` — add a test: when both keys are absent from the file config, the resolved values equal 600.
- [ ] 4.2 `core/test/config.test.ts` — add a test: when `intake_timeout: 300` is present, the resolved value is 300 (file overrides default).
- [ ] 4.3 `core/test/config.test.ts` — add a test: when `intake_timeout: 0` or `intake_timeout: "abc"` is set, `resolveConfig()` throws (schema rejects invalid values).
- [ ] 4.4 `core/test/intake.test.ts` — add a regression test: the fake `runHarness` records the `timeoutSec` argument; assert it equals the config value passed to `realIntakeDeps` (or provided via the fake dep).
- [ ] 4.5 `core/test/sweep.test.ts` — add a regression test: the fake `runHarness` records the `timeoutSec` argument; assert it equals the config value passed to `realSweepDeps`.

## 5. Mirror + CI

- [ ] 5.1 `node scripts/build.mjs`; verify mirror is in sync.
- [ ] 5.2 `npm run ci` green end-to-end.
