## 1. harness.ts — Add reasoningEffort to InvokeOptions

- [ ] 1.1 Add optional `reasoningEffort?: string` field to the `InvokeOptions` interface in `core/scripts/harness.ts`
- [ ] 1.2 In the `"codex"` branch of `invoke()`, insert `-c model_reasoning_effort=<value>` into the args array (before the prompt positional) when `opts.reasoningEffort` is set
- [ ] 1.3 Write a unit test in `core/test/harness.test.ts` asserting that `invoke("codex", ...)` with `reasoningEffort: "medium"` spawns codex with the `-c model_reasoning_effort=medium` flag; assert the flag is absent when `reasoningEffort` is omitted; assert the flag is absent for the claude harness

## 2. types.ts + config.ts — Add plan_review_timeout config field

- [ ] 2.1 Add `plan_review_timeout: number` to the `PipelineConfig` interface in `core/scripts/types.ts`; set `DEFAULT_CONFIG.plan_review_timeout` to `300`
- [ ] 2.2 Add `plan_review_timeout: z.number().int().positive().optional().describe("Seconds for the plan-review harness before timing out.")` to `PartialConfigSchema` in `core/scripts/config.ts`
- [ ] 2.3 Wire `fileConfig.plan_review_timeout ?? DEFAULT_CONFIG.plan_review_timeout` in `resolveConfig()` in `config.ts`
- [ ] 2.4 Add the config-template line `plan_review_timeout: ${d.plan_review_timeout} # seconds for plan-review harness` to the template string in `config.ts`
- [ ] 2.5 Write unit tests in `core/test/config.test.ts` covering: absent key → 300, explicit value accepted, non-positive value rejected, non-integer value rejected

## 3. planning.ts — Wire controls and verdict validation

- [ ] 3.1 Update the plan-review `invokeReviewer` call in `runPlanningPhases` (`planning.ts:~L357`) to pass `timeoutSec: cfg.plan_review_timeout` (replacing `cfg.review_timeout`) and add `reasoningEffort: "medium"` to the options
- [ ] 3.2 After receiving non-empty plan-review output (`planReview`), add a check for the `## Plan Review Verdict` header; when absent, call `setBlocked` with tag `"needs-human"` and a message containing `"plan-review output missing required"` and `"## Plan Review Verdict"`, then return early
- [ ] 3.3 Write a unit test in `core/test/planning.test.ts` asserting: (a) plan-review output with `## Plan Review Verdict` advances to revision; (b) plan-review output without the header blocks the issue at `plan-review` with the expected message; (c) empty plan-review output also blocks

## 4. Mirror regeneration and CI

- [ ] 4.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/` after all `core/` changes
- [ ] 4.2 Run `npm run ci` from the repo root; confirm all three stages pass (`ci:core`, `build.mjs --check`, `ci:install-smoke`)
