## 1. Capability declaration and treatment identity

- [x] 1.1 Add versioned `background_job_lifecycle` to the adapter capability and extension-declaration surface (`supported: false` or `supported: true` with schema `pipeline/background-job-lifecycle@1` and optional `join_grace_ms`), and verify a type/runtime fixture rejects an omitted field.
- [x] 1.2 Encode the pipeline-owned `@1` maximum join grace as 120_000 ms, treat adapter values as `min(declared, 120_000)`, and verify conformance fails a declaration whose join grace exceeds that maximum.
- [x] 1.3 Include the lifecycle declaration in `hashAdapterCapabilities`, and verify two otherwise identical adapters that differ only in supported vs unsupported produce different hashes and that removing the field from the hash payload fails the pin test.

## 2. Built-in adapters, conformance, and protocol fixtures

- [x] 2.1 Verify each built-in adapter's raw headless protocol against the lifecycle event schema (`claude`, `codex`, `grok`, `pi`, `opencode`) and declare support only when the protocol can prove job identity, start, complete or fail, notification delivery, and foreground-join; verify every built-in exposes an explicit supported or unsupported value.
- [x] 2.2 Add conformance fixtures for historical Claude `#547` evidence and the new incident adapter provenance, and verify each fixture remains explicitly unsupported when its raw protocol cannot prove lifecycle state (transcript mentions of a background test run MUST NOT flip support).
- [x] 2.3 Extend the shared conformance kit so a registered adapter that omits `background_job_lifecycle`, claims support without a schema, or loosens the pipeline join maximum fails by naming the field, and verify the kit iterates built-in and extension/compatibility adapters.

## 3. Typed lifecycle stream and join-grace watchdog

- [x] 3.1 Define the closed event kinds (`job_started`, `job_completed`, `job_failed`, `notification_delivered`, `foreground_joined`) with allowlisted fields only (schema, adapter, invocation id, job id, timestamp, state), and verify a unit test rejects payloads that carry command, tool output, prompt, or secret text into persisted evidence.
- [x] 3.2 Parse supporting-adapter CLI streams into those events on the existing capped invoke path, inject the stream through a `deps` seam, and verify unit tests do not spawn a real harness subprocess.
- [x] 3.3 After `job_completed` or `job_failed`, require both notification delivery and foreground-join inside the effective grace; on miss, terminate before the outer `implementation_timeout` with `background_wait` set and `timed_out` unset; verify completed-but-undelivered and unjoined fixtures bite (they fail if the watchdog is removed or if the result sets `timed_out`).
- [x] 3.4 Allow a started job with no complete/fail to run until the remaining outer cap and classify that expiry as `harness-timeout`, and verify a long-running-job fixture with outer cap smaller than a fake clock's complete event is `harness-timeout` not `harness-background-wait`.
- [x] 3.5 Treat malformed and duplicate events as non-joins (identical duplicates are idempotent; conflicting state is not a join), redact before diagnostics, and verify those fixtures do not emit `harness-background-wait` from inactivity or from waiting prose with no typed complete/fail.

## 4. Diagnostic reason, preflight, and retry bound

- [x] 4.1 Add `harness-background-wait` to `STAGE_DIAGNOSTIC_REASON_CODES`, map `background_wait` before `timed_out` in `classifyHarnessFailure`, project to `workflow-engine-defect` / `recover`, and verify exhaustive switches (`interventionKindFromReason`, `isMechanicalInfrastructureReason`, reason-code iteration tests) include the member and that silence/`timed_out` alone does not produce it.
- [x] 4.2 Refuse implement, fix-round, test-fix, eval-fix, and visual-fix before spawn when the assigned adapter declares `background_job_lifecycle` unsupported, emit typed `capability-refusal` naming the adapter and capability, and verify planning and review on that adapter still spawn (injected preflight; no real CLI).
- [x] 4.3 Refuse automatic retry of the same adapter on the same invocation fingerprint after `harness-background-wait`, leave existing explicit harness policy as the only alternate-adapter path, and verify a retry fixture does not spawn and does not invent a fallback adapter.

## 5. Salvage without successful-stage or publish

- [x] 5.1 On `harness-background-wait` with salvageable uncommitted work, run the existing salvage/checkpoint path (exclusions, trailers, owned-path scope when present), retain salvage evidence, keep the stage outcome as `harness-background-wait`, and verify the invocation does not proceed to the successful-implement test-gate / PR / `review-1` path.
- [x] 5.2 On `harness-background-wait` with a clean tree, create no salvage commit and keep the outcome, and verify a salvage-git-failure still reports `harness-background-wait` with the captured salvage failure reason.
- [x] 5.3 Do not claim `publish_unpublished_stage_commit` from this reason, do not set `timed_out`, and verify a salvage-plus-background-wait fixture does not open a PR or transition to `review-1`.

## 6. Prompt discipline coexistence

- [x] 6.1 Keep existing single-turn / foreground prompt-loader assertions, and verify a lifecycle-tracked background job that joins inside grace is not failed as a prompt-discipline violation while waiting-prose without typed complete/fail still does not classify as `harness-background-wait`.

## 7. Mirror, validate, CI

- [x] 7.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [x] 7.2 Run `openspec validate harness-background-job-lifecycle` until clean, then `npm run ci` from the repo root, and verify both are green.
