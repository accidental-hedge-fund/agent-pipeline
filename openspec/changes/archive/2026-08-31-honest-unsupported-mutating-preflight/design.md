## Context

#1299 added `background_job_lifecycle` and refused mutating implementer stages when the adapter declared `supported: false`. Protocol fixtures correctly keep every built-in at unsupported. The factory implementer is Grok. After promote, implement and fix cannot spawn.

The hang class #1299 targeted (complete/fail without delivery or join) still requires typed events. Unsupported adapters cannot emit those events. Refusing spawn was meant to wait for a supporting adapter. That adapter never shipped. The factory is inoperable.

## Goals / Non-Goals

**Goals:**

- Restore mutating spawn for adapters that **declare** non-support.
- Keep fail-closed when the field is **omitted**.
- Keep the join-grace watchdog only on `supported: true`.
- Stop fix-round from retrying a typed preflight refusal as a crash.

**Non-Goals:**

- Claiming built-in adapters support the lifecycle protocol.
- Hidden cross-adapter fallback.
- Changing planning/review exemption.
- Auto-merge.

## Decisions

### D1: Explicit unsupported means foreground, not banned

**Decision:** Mutating preflight refuses only a missing `background_job_lifecycle` object. `{ supported: false }` proceeds to spawn. `runCapped` already skips the lifecycle supervisor when `supported !== true`.

**Rationale:** Honest non-support is "I cannot prove join." Outer `implementation_timeout` / `fix_timeout` still bound the process. Inventing events is still forbidden.

**Alternatives:** Fake grok support (rejected: #1299 D2). Keep refuse-all-unsupported (rejected: zero supporting builtins; factory cannot run).

### D2: Omitted field stays fail-closed

**Decision:** `!lifecycle` on a mutating `stageKind` is still `capability-refusal` before spawn. Conformance still fails omitted declarations.

**Rationale:** The field is required identity. Missing it is not "foreground."

### D3: Fix-round does not retry preflight_failed

**Decision:** `invokeFixHarnessWithRetry` returns after the first `preflight_failed` result, the same way it already returns on `background_wait`. The blocked outcome carries `buildStageDiagnostic({ reasonCode: classifyHarnessFailure(result) })`. `classifyHarnessFailure` maps `preflight_reason_code: capability-refusal` before the exit-code fallback.

**Rationale:** Retrying the same treatment cannot succeed. #1354/#1350 retried `exit -1` twice and then recovered with scratch/dirt recipes that cannot affect a capability refusal.

## Risks / Trade-offs

- Grok/Claude implement can hang until the outer stage cap again if the CLI waits on a notification the pipeline never sees. That is the pre-#1299 hang. It is operable. A supporting protocol remains the hang-class fix. This change restores a factory that can spawn.
