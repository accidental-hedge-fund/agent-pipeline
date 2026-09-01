## 1. Audit remaining refusal paths after #1365

- [ ] 1.1 List remaining genuine production-preflight refusal paths against current `runProductionPreflight`, `harness.invoke`, `invokeFixHarnessWithRetry`, implement / test-fix / eval-fix / visual-fix consumers, `classifyHarnessFailure`, and recovery recipe selection, and verify the list names covering tests for already-proven #1364 `supported: false` spawn and fix-round one-shot `preflight_failed`
- [ ] 1.2 If every acceptance criterion is already proven, close #1362 with the covering commit SHAs and tests and verify no application-code PR is opened

## 2. Malformed required lifecycle at production preflight

- [ ] 2.1 Call existing `backgroundJobLifecycleCoherenceFailure` from mutating-stage production preflight after the omitted-object check, and verify a malformed declaration (`supported` not boolean, or `supported: true` without coherent schema) returns `preflight_failed` with `preflight_reason_code: capability-refusal` and does not spawn
- [ ] 2.2 Keep explicit `{ supported: false }` spawn-allowed with the lifecycle supervisor off, and verify the existing #1364 compatibility tests still pass
- [ ] 2.3 Keep `supported: true` under a coherent schema on the join-grace watchdog path, and verify a supported-adapter mutating invoke is not refused by this check

## 3. Preserve typed fields on mutating stage outcomes

- [ ] 3.1 Keep `invokeFixHarnessWithRetry` one-shot on `preflight_failed` for `fix-1`, and verify one invocation, zero `fix_harness_retry` events, typed `capability-refusal` diagnostic (not `exit -1` / `workflow-engine-defect`), and zero harness sessions
- [ ] 3.2 Stop implement from flattening `preflight_failed` to `exit ${exit_code}`, and verify the blocked outcome keeps `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and bounded message
- [ ] 3.3 Stop at least one of test-fix, eval-fix, or visual-fix from flattening `preflight_failed` to `exit ${exit_code}`, and verify that stage records one treatment invocation and does not start another harness session for the same refusal
- [ ] 3.4 Apply the same typed-reason formatting to the remaining mutating consumers in that set, and verify spawn error, signal termination, timeout, malformed harness output, and environment-auth stay distinct classes

## 4. Recovery observation and inapplicable recipes

- [ ] 4.1 Filter unlink-scratch, checkpoint-dirt, force-push, and worktree-removal when `preflight_failed` and the harness never started, reusing the `filterRecipesForHarnessBackgroundWait` pattern, and verify those recipes are not claimed on a clean worktree
- [ ] 4.2 Treat an empty remaining recipe list as inapplicable, not exhaustion, and verify recovery does not record exhaustion for those skipped recipes
- [ ] 4.3 Keep omitted/malformed lifecycle as mechanical `capability-refusal` recover (not human authority, not a new grill `CapabilityRequest`), and verify `environment-auth` still uses `verify_authentication`

## 5. Durable evidence without secrets

- [ ] 5.1 Record `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and the bounded sanitized message on the stage diagnostic / evidence path, and verify a fixture with credential-shaped diagnostic text is redacted and contains no prompt body

## 6. Tests, packaging, and CI

- [ ] 6.1 Add injected-I/O regression tests for fix-1 and at least one other mutating stage that fail if typed fields are flattened to `exit -1`, and verify they perform no real network, git, or subprocess calls
- [ ] 6.2 Keep #1364 `supported: false` compatibility coverage green, and verify those tests still assert spawn-allowed mutating preflight
- [ ] 6.3 After any `core/` edit run `node scripts/build.mjs` and `npm run ci` from the repo root, and verify both exit 0
