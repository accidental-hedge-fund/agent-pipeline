## Why

v1.40.0 shipped #1299's mutating-implementer preflight: product-mutating stages refuse any adapter that declares `background_job_lifecycle` unsupported. Every built-in adapter (`claude`, `codex`, `grok`, `pi`, `opencode`) honestly declares unsupported because no built-in CLI protocol proves join. The factory config uses `harnesses.implementer: grok`.

The promoted engine therefore cannot spawn Grok (or any built-in) for implement or fix. Planning still runs. Implementing publishes the planning commit. Review blocks on OpenSpec-only diffs. `fix-1` hits the same refusal, crash-retries it as `exit -1` (#1362), and the loop dies `workflow-engine-defect`. Observed on #1354 and #1350. The v1.40.1 train was stopped.

#1299 D3 treated honest non-support as "illegal to mutate." That decision assumed a supporting adapter would exist. None shipped. Explicit `supported: false` must mean "cannot prove join; run in the foreground under the existing timeout." Omitted declarations stay fail-closed.

## What Changes

- Mutating-stage production preflight refuses only an **omitted** `background_job_lifecycle` field.
- An explicit `supported: false` declaration spawns. The lifecycle supervisor stays off. No invented events. Outer timeout and salvage stay.
- Supported adapters keep the #1299 join-grace watchdog and no same-adapter retry after `harness-background-wait`.
- Fix-round does not crash-retry `preflight_failed`. Classify typed `capability-refusal` instead of bare `exit -1` → `workflow-engine-defect`.
- Do not claim built-in lifecycle support. Do not add a hidden adapter fallback.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `cli-harness-adapters`: Mutating implementer preflight SHALL refuse omitted `background_job_lifecycle` and SHALL spawn explicit non-support.
- `fix-harness-crash-retry`: A typed production-preflight refusal SHALL NOT enter the crash/timeout retry loop.

## Acceptance criteria

- [ ] Mutating `stageKind` + explicit unsupported lifecycle → production preflight `ok: true` (injected; no real CLI). Built-in grok/claude/codex implement preflight is not refused for this declaration.
- [ ] Mutating `stageKind` + omitted lifecycle field → still `capability-refusal` before spawn.
- [ ] `invokeFixHarnessWithRetry` with `preflight_failed` + `preflight_reason_code: capability-refusal` → exactly one attempt, zero `fix_harness_retry`.
- [ ] `classifyHarnessFailure` maps `preflight_reason_code: capability-refusal` to `capability-refusal`, not `workflow-engine-defect`.
- [ ] Supported adapter still runs the lifecycle supervisor path; same-adapter retry after `harness-background-wait` still refused.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.

## Impact

- `core/scripts/harness-adapters/production-preflight.ts`: refuse omitted lifecycle only.
- `core/scripts/stages/fix.ts`: no crash-retry of `preflight_failed`; attach typed diagnostic.
- `core/scripts/escalation-classify.ts`: honor `preflight_reason_code: capability-refusal`.
- Tests in `harness-background-job-lifecycle.test.ts`, `fix.test.ts`, `escalation-dispositions.test.ts`.
- Living specs `cli-harness-adapters` and `fix-harness-crash-retry`.
