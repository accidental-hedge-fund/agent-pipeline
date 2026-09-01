## Why

A genuine typed production-preflight refusal can still be flattened to `exit -1`, retried as a harness crash, and sent through worktree recipes that do not apply when the harness never started. That drops `preflight_failed`, `preflight_class`, `preflight_reason_code`, and intervention kind, and can claim recovery exhaustion for inapplicable recipes. #1364 / PR #1365 already made explicit `background_job_lifecycle.supported: false` spawn with the lifecycle supervisor off. This change keeps that contract and preserves every remaining genuine refusal (omitted or malformed required lifecycle, plus other typed production-preflight refusals) through stage outcome, durable evidence, retry classification, and recovery observation.

## What Changes

- Audit the post-#1365 main path first. If every required behavior is already proven by existing commits and tests, close #1362 with those covering tests and do not open a no-op PR.
- Refuse omitted **and** malformed required lifecycle declarations before spawn as typed `capability-refusal`. Explicit `supported: false` stays spawn-allowed compatibility, not refusal. `supported: true` keeps the join-grace watchdog.
- Keep typed fields on the harness result and on the stage outcome for every mutating implementer stage (`implement`, `fix-round` / `fix-1`, `test-fix`, `eval-fix`, `visual-fix`): `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and a bounded actionable message.
- Do not retry a deterministic refusal as a crash. Record one stage-treatment invocation, zero harness sessions, and zero harness retry events. Existing crash and timeout retry stays bounded and unchanged.
- Do not invent a harness session, switch adapters, or select unlink-scratch, checkpoint-dirt, force-push, or worktree-removal when the harness never started and the worktree is clean. Inapplicable recovery is not recovery exhaustion.
- Keep mechanical routing failure engine-owned. Do not promote it to human authority. A true unavailable capability that needs supplied input becomes a typed `CapabilityRequest`. An external condition that is currently false becomes an external-condition wait.
- Persist the typed fields in durable evidence. Do not store prompt content or secrets.
- Do not add merge, release, destructive-operation, or implicit adapter-fallback authority.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `cli-harness-adapters`: Production invoke SHALL refuse omitted and malformed required lifecycle declarations as typed `capability-refusal`, SHALL keep explicit `supported: false` spawn-allowed, SHALL preserve typed preflight fields on the harness result, SHALL NOT spawn or switch adapters, and SHALL keep the refusal distinct from spawn error, signal termination, timeout, malformed harness output, and environment-auth.
- `fix-harness-crash-retry`: A typed production-preflight refusal SHALL remain one-shot on `fix-1` / `fix-2`. The blocked reason SHALL keep the typed diagnostic and SHALL NOT flatten to `exit -1` / `workflow-engine-defect`. Crash and timeout retry SHALL stay bounded.
- `harness-background-job-lifecycle`: Malformed required lifecycle declarations SHALL refuse the same way omitted declarations refuse. Explicit `supported: false` SHALL remain compatibility, not capability-refusal. `supported: true` SHALL retain the watchdog.
- `autonomous-recovery-controller`: Recovery SHALL observe the typed preflight refusal. It SHALL NOT select unlink-scratch, checkpoint-dirt, force-push, or worktree-removal when the harness never started and the worktree is clean. Inapplicable recipes SHALL NOT count as recovery exhaustion. Mechanical routing failure SHALL stay engine-owned and SHALL NOT become human authority.
- `evidence-bundle`: Durable evidence for a typed production-preflight refusal SHALL record `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and the bounded message. It SHALL NOT record prompt content or secrets.

## Impact

- Shared path: `core/scripts/harness-adapters/production-preflight.ts` (call existing `backgroundJobLifecycleCoherenceFailure` for malformed required lifecycle), `core/scripts/harness.ts` (typed `HarnessResult` fields already exist), `core/scripts/escalation-classify.ts` / `core/scripts/stage-diagnostic.ts` (keep `capability-refusal` ahead of exit-code fallback).
- Stage consumers that still flatten `preflight_failed` to `exit ${exit_code}`: `core/scripts/stages/planning.ts` (implement), `core/scripts/testgate.ts` (test-fix), `core/scripts/stages/eval.ts` (eval-fix), `core/scripts/stages/visual.ts` (visual-fix). `core/scripts/stages/fix.ts` already short-circuits `invokeFixHarnessWithRetry` on `preflight_failed`.
- Recovery: reuse the existing recipe-filter pattern (`filterRecipesForHarnessBackgroundWait`) rather than a new RecoverySupervisor module. Report the typed observation through `HarnessResult` + `buildStageDiagnostic` so the current controller and any forthcoming RecoverySupervisor see the same fields.
- Tests: injected I/O only. Cover `fix-1` and at least one other mutating stage. Keep the existing #1364 `supported: false` compatibility tests.
- Packaging: `node scripts/build.mjs` after any `core/` edit. `npm run ci` must pass when code changes remain necessary.

## Acceptance criteria

- [ ] An audit of current main after #1365 lists the remaining genuine preflight-refusal paths (or names the covering commit and tests and closes #1362 with no no-op PR).
- [ ] Omitted required lifecycle declaration on a mutating `stageKind` refuses before spawn with `preflight_failed`, `preflight_class`, `preflight_reason_code: capability-refusal`, intervention kind `auth-tooling-preflight-failure`, and a bounded actionable message.
- [ ] Malformed required lifecycle declaration (for example `supported` not boolean, or `supported: true` without the coherent schema) refuses the same way as omitted, before spawn.
- [ ] Explicit `background_job_lifecycle: { supported: false }` on a mutating `stageKind` is not classified as capability-refusal and proceeds to spawn with the lifecycle supervisor disabled. `supported: true` retains the join-grace watchdog.
- [ ] A genuine deterministic refusal records one stage-treatment invocation, zero harness sessions, and zero harness retry events (`fix_harness_retry` or equivalent).
- [ ] The same treatment is not retried. Existing crash and timeout retry remains bounded and unchanged.
- [ ] The refusal stays distinct from spawn error, signal termination, timeout, malformed harness output, and environment-auth.
- [ ] `fix-1` and at least one other mutating stage (`implement`, `test-fix`, `eval-fix`, or `visual-fix`) preserve the typed fields on the stage outcome and do not flatten the reason to `exit -1`.
- [ ] Recovery does not select `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, force-push, or worktree-removal when the harness never started and the worktree is clean. That miss is not recovery exhaustion.
- [ ] Mechanical omitted/malformed routing failure stays engine-owned (`capability-refusal` / recover) and does not become human authority. A true unavailable capability that needs supplied input becomes `CapabilityRequest`. An external condition that is currently false becomes an external-condition wait.
- [ ] Durable evidence records the typed fields and bounded message and does not contain prompt content or secrets.
- [ ] No merge, release, destructive-operation, or implicit adapter-fallback authority is added.
- [ ] Tests use injected I/O only and include explicit `supported: false` compatibility from #1364.
- [ ] `node scripts/build.mjs` and `npm run ci` pass when code changes remain necessary.
