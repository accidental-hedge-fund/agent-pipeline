## 1. Preflight spawn restore

- [x] 1.1 Refuse mutating implementer preflight only when `background_job_lifecycle` is omitted; spawn when `supported: false`.
- [x] 1.2 Update the omitted-field refusal message so it names omission, not honest non-support.

## 2. Fix-path typed refusal

- [x] 2.1 `invokeFixHarnessWithRetry` returns after the first `preflight_failed` result (no `fix_harness_retry`).
- [x] 2.2 `classifyHarnessFailure` maps `preflight_reason_code: capability-refusal` to `capability-refusal`.
- [x] 2.3 Fix-round blocked outcomes attach that diagnostic instead of synthesizing `workflow-engine-defect` from `exit -1`.

## 3. Tests

- [x] 3.1 Mutating `stageKind` + explicit unsupported → preflight ok; omitted → capability-refusal; grok/claude implement not refused for the declaration.
- [x] 3.2 `invokeFixHarnessWithRetry` preflight refusal → one attempt.
- [x] 3.3 Same-adapter retry after `harness-background-wait` still refused.

## 4. Specs

- [x] 4.1 Delta `cli-harness-adapters` mutating-preflight requirement.
- [x] 4.2 Delta `fix-harness-crash-retry` so typed preflight refusals are not retried.
