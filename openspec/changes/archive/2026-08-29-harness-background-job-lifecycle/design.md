## Context

See `proposal.md` for motivation and the lyric-utils `#268` / `#547` hang.

**Class vs site (engine-dogfood bar):**

| Question | Answer |
| --- | --- |
| Class | A background job completes or fails and its result is not delivered and foreground-joined within a versioned grace. Adapters that cannot prove that lifecycle MUST NOT run mutating implementation work. |
| Site | Implementing on lyric-utils `#268` (and historically `#547`) waiting for a background test-run notification until `implementation_timeout`. |
| Shared law | Versioned `background_job_lifecycle` capability + preflight `capability-refusal` + join-grace watchdog + reason `harness-background-wait` + salvage-without-success + no same-adapter retry. |
| Next identical fault | Any product-mutating implementer stage (implement, fix-round, test-fix, eval-fix, visual-fix) on any adapter. That path MUST use this contract. A prompt-only "do not background" line, a longer timeout, or an implementing-only salvage special case is a mole. |

**Current constraints:**

- `#547` already requires single-turn prompt text and salvage of uncommitted work. Prompt text did not stop the hang. Salvage preserves files but leaves the stage as a timeout.
- `#1272` / `unpublished-stage-commit-publish` publishes salvage after `harness-timeout`. This change MUST NOT set `timed_out` for a join miss, so that path does not fire as a side effect. `#1272` remains the owner of publication.
- `cli-harness-adapters` already has a typed capability surface, preflight, and a conformance kit. The new capability belongs there, not in a name-branched `if (harness === "claude")` wait.
- `pipeline/stage-diagnostic@1` already has additive mechanical reasons (`harness-timeout`, `harness-contract`, `capability-refusal`). Living spec text that lists an older "exactly" set is stale relative to `STAGE_DIAGNOSTIC_REASON_CODES`; this change adds one more additive member on that established path.
- Host-local invoke is the supported concurrency scope. Lifecycle events are per invocation, not cross-host.

## Goals / Non-Goals

**Goals:**

- Typed lifecycle evidence as the only proof of a background wait.
- Bounded termination after complete/fail-without-join, before the outer stage cap.
- Explicit per-adapter support / non-support, verified against the raw protocol.
- Distinct reason code so operators do not raise `implementation_timeout`.
- Salvage retained; stage outcome stays `harness-background-wait`.

**Non-Goals:**

- Publishing a PR, recover-parked changes, park-release changes, or `publish_unpublished_stage_commit` wiring (`#1272`).
- Banning background execution, or using inactivity / transcript wording as a hang detector.
- Raising or lowering `implementation_timeout` as the fix.
- Hidden adapter fallback, LLM-first recovery, or a merge stage.
- Inventing lifecycle events for an adapter whose protocol cannot prove them.
- Cross-host job tracking.

## Decisions

### D1: Versioned capability on the existing adapter surface

**Decision:** Add `background_job_lifecycle` to `AdapterCapabilities` and the extension declaration. Encoding:

- `{ supported: false }`
- `{ supported: true, schema: "pipeline/background-job-lifecycle@1", join_grace_ms?: number }`

Omitted is invalid. Conformance fails missing or incoherent declarations. `hashAdapterCapabilities` includes the declaration so treatment identity moves when support changes.

**Rationale:** The hang is an adapter/host notification gap, not an issue-specific implement bug. Name-branched waits would mole the next adapter.

**Alternatives:** Prompt-only foreground rule (rejected: `#547` already shipped it). Generic inactivity watchdog (rejected: locked design forbids silence as proof). Per-stage special case in `planning.ts` (rejected: class-over-site).

### D2: Protocol verification owns support; fixtures pin non-proof adapters

**Decision:** Implementation verifies each built-in CLI's raw headless protocol against the event schema before declaring support. Historical Claude `#547` evidence and the new incident adapter provenance become conformance fixtures. If that protocol cannot emit job identity, start, complete or fail, notification delivery, and foreground-join, the adapter stays `supported: false`. Do not infer support from marketing names or from transcript phrases about background tests.

**Rationale:** `#547` and `#268` hung because a notification the model expected never arrived in the pipeline-owned invoke. Faking support would reintroduce the hang.

**Alternatives:** Mark every jsonl adapter supported (rejected: jsonl telemetry is not lifecycle). Mark Claude unsupported without a fixture (rejected: the next incident would not have a biting protocol fixture).

### D3: Mutating implementer preflight; planning and review exempt

**Decision:** Product-mutating implementer stages (implement, fix-round, test-fix, eval-fix, visual-fix) refuse `supported: false` with `capability-refusal` before spawn. Planning, plan-review, and review do not consult this capability. Same-invocation retry of a refused adapter cannot succeed; the message says so.

**Rationale:** The hang class is a mutating implementer waiting on a suite (or equivalent) job. Review verdicts are not that class. Reusing `capability-refusal` matches prompt-limit and unsupported-setting refusals.

**Alternatives:** Refuse all stages (rejected: blocks review on a still-valid reviewer). Allow implement on unsupported adapters and detect hangs later (rejected: locked design requires preflight refusal; unsupported adapters cannot prove the wait).

### D4: Typed event stream on the capped invoke path

**Decision:** Supporting adapters parse their existing CLI stream (jsonl or documented equivalent) into a closed event enum: `job_started`, `job_completed`, `job_failed`, `notification_delivered`, `foreground_joined`. Each event carries `schema`, adapter, invocation id, stable `job_id`, timestamp, and state. The invoke supervisor on `runCapped` consumes the stream. Unit tests inject the stream through a `deps` seam. No transcript scraper. No second watcher process.

Malformed or duplicate events: ignore as join proof; keep the job unjoined; redact any leaked payload before diagnostics. Duplicate identical events for the same `job_id` and kind are idempotent.

**Rationale:** Locked design requires typed stable identity and forbids raw command/tool/prompt/secret evidence. The capped path already owns timeout and process-tree kill.

**Alternatives:** Host-level "background bash notification" hooks (rejected: that is the missing channel). Parse `terminal.log` for "Let's check on the background test" (rejected: transcript is not proof).

### D5: Two clocks — outer stage cap vs join grace

**Decision:** Schema version `@1` pipeline maximum join grace is **120_000 ms**. Effective grace = `min(120_000, adapter.join_grace_ms ?? 120_000)`. Adapter values above 120_000 fail conformance. Changing the pipeline maximum requires a schema version bump.

State machine per `job_id`:

1. `job_started` and no complete/fail → job may run until remaining `implementation_timeout`. Outer expiry → `harness-timeout` (`timed_out: true`).
2. `job_completed` or `job_failed` starts the join-grace clock. Both `notification_delivered` and `foreground_joined` MUST arrive before effective grace. Missing either → terminate wait as `harness-background-wait`, `timed_out: false`, before the outer cap when grace is smaller (it always is versus 2400s+ implement caps).
3. Valid join → no new reason; harness continues.

**Rationale:** The `#268` signature was ~5s over the outer cap. Join after the job is already done is a delivery problem, not more test work. 120s is large enough for a slow notify path and far below implement caps, so operators stop raising the timeout.

**Alternatives:** One clock (`implementation_timeout`) for everything (rejected: that is the current hang). Inactivity N minutes (rejected: not distinguishable from a long job). Adapter-only grace with no pipeline max (rejected: an adapter could restore unbounded wait).

### D6: Distinct result flag; do not set `timed_out`

**Decision:** `HarnessResult` (or the structured failure signals) gains an explicit `background_wait` (or equivalent) flag. `classifyHarnessFailure` maps that flag to `harness-background-wait` **before** `timed_out`. This class MUST NOT set `timed_out: true`. `projectPipelineReasonCode("harness-background-wait")` → `workflow-engine-defect` / `recover`. Exhaustive switches (`interventionKindFromReason`, `isMechanicalInfrastructureReason`, tests over `STAGE_DIAGNOSTIC_REASON_CODES`) gain the member.

**Rationale:** `#1272` publish keys off timeout-class salvage. If we set `timed_out`, this issue would open a PR and violate the `#1272` boundary. Distinct reason also stops the "raise the cap" operator response.

**Alternatives:** Reuse `harness-timeout` with extra evidence (rejected: locked design). Reuse `external-wait` (rejected: that is upstream-dependency, not an adapter join miss).

### D7: Salvage yes; success and publish no

**Decision:** On `harness-background-wait`, call the existing salvage/checkpoint path when porcelain is salvageable. Keep `reason_code: harness-background-wait`. Do not take the successful-implement afterRound path (test gate as pass, push, PR, `review-1`). Do not claim `publish_unpublished_stage_commit`. Do not change recover-parked or park-release.

**Rationale:** `#547` salvage is useful and already specified. `#1272` owns making that commit reachable. Mixing them in this change would hide the join miss behind a publish.

**Alternatives:** Salvage then publish (rejected: `#1272` scope). Skip salvage (rejected: discards finished work again).

### D8: No same-adapter retry; no hidden fallback

**Decision:** Recovery and stage retry MUST NOT re-spawn the same adapter on the same invocation fingerprint after `harness-background-wait`. Capability-refusal for unsupported adapters already states that retry cannot succeed. Alternate adapters only via existing explicit harness policy (`executors` / role assignment). No new fallback table.

**Rationale:** Retrying the same unjoined notify path is the hang again. Silent adapter substitution would change the treatment being measured (`cli-harness-adapters` already forbids that on preflight failure).

**Alternatives:** One automatic retry (rejected: locked design). Switch to profile default implementer (rejected: hidden fallback).

### D9: Prompt discipline stays; engine permission is separate

**Decision:** Do not remove single-turn / foreground prompt text. Do not use that text, or its absence, as a classifier. Engine permits lifecycle-tracked background jobs.

**Rationale:** Resolves the living-spec conflict without averaging. Prompts remain guidance. Engine owns the hang.

**Alternatives:** Delete prompt discipline (rejected: loses a cheap guard). Make background a prompt-discipline failure (rejected: locked design permits background).

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| No built-in adapter can prove lifecycle, so all mutating implement work preflight-fails | Honest unsupported declarations plus visible `capability-refusal`; operators assign a supporting adapter. Do not fake support to keep a default implementer. |
| A jsonl adapter is marked supported but its "complete" event is not actually delivered to the model | Require both notification delivery and foreground-join; fixtures from `#547` / new incident must fail support if those events are absent. |
| Join-grace too short kills a slow but real notify path | 120s pipeline max; adapters may only tighten. Schema bump to change the max. |
| Join-grace too long still looks like a hang | 120s is ~2% of a 2400s implement cap; still ends minutes, not hours, before the outer kill. |
| `#1272` timeout publish accidentally fires | Never set `timed_out` for this class; controller MUST NOT claim publish from this reason. |
| Malformed events leak secrets into blocker comments | Allowlist + redaction before persist; malformed events are not joins. |
| Exhaustive reason-code switches miss the new member | Additive member on `STAGE_DIAGNOSTIC_REASON_CODES`; existing tests that iterate the const must include it. |
| Prompt vs engine conflict during review | Spec delta on `single-turn-harness-discipline` states both remain. |

## Migration Plan

1. Specs + design land in this change (planning). No runtime change yet.
2. Implementation: capability field + conformance + protocol fixtures + event types + supervisor join grace + reason code + salvage-without-success + hash input. Regenerate `plugin/` with any `core/` edit.
3. Built-in adapters declare support only after protocol verification recorded in adapter headers or verified-against notes (same pattern as prompt-delivery re-verification).
4. Rollback: omit the capability check and watchdog; do not leave a half-wired reason that still sets `timed_out`.
5. Archive into living specs on pre-merge when acceptance is green.

## Open Questions

None. Per-adapter support is an implementation verification task, not a product question that would change these specs.
