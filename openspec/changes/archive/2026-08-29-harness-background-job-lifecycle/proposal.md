## Why

An implementing (or other product-mutating) harness can finish the product work, start a
background test run, and then hang until `implementation_timeout` waiting for a completion
notification that the embedded harness never delivers. Two lyric-utils `#268` attempts failed at
2405s and 3605s — about five seconds over the configured cap — with the same log shape as closed
issue `#547`. `#547` shipped salvage of uncommitted work (v1.28.0). It did not fix the wait.
Raising the cap only lengthens the hang. Combined with unpublished salvage (`#1272`), the result
is a dead end that needs manual rescue.

This is engine dogfood, not an implementing-timeout mole. **Class:** a background job whose
completion or failure is not delivered and foreground-joined, plus any adapter that cannot prove
that lifecycle and is still selected for mutating implementation work. **Site:** implementing on
lyric-utils `#268` (and historically `#547`) waiting for a background test-run notification.
The next identical hang at implement, fix, or another product-mutating implementer stage MUST hit
the same capability, preflight, join bound, and reason code — not a new mole issue.

## What Changes

- Add a versioned adapter capability `background_job_lifecycle`. Supporting adapters stream typed
  stable job identity, start, completion or failure, notification delivery, and foreground-join
  events. Lifecycle evidence is allowlisted (adapter and invocation correlation, job identity,
  timestamps, state). It excludes raw commands, tool output, prompts, and secrets.
- Every built-in adapter SHALL declare support or non-support. An adapter whose raw protocol
  cannot prove lifecycle state remains explicitly unsupported. Mutating implementation work fails
  preflight with `capability-refusal` when the selected adapter lacks support. Planning and review
  are unaffected.
- Background execution is permitted. A running job may continue within the remaining stage
  deadline (`implementation_timeout` stays the outer cap). After a job completes or fails, its
  result MUST be delivered and foreground-joined within a separate grace period. Pipeline owns a
  versioned maximum; an adapter MAY declare a tighter bound and MUST NOT weaken it.
- Missing delivery or join emits closed reason code `harness-background-wait` with bounded typed
  lifecycle evidence. It is not `harness-timeout`. It is never inferred from transcript wording
  or generic inactivity.
- Do not automatically retry the same adapter for the same invocation fingerprint. Selecting
  another adapter requires existing explicit harness policy; there is no hidden fallback.
- Run the existing bounded salvage path and retain its evidence. Keep the stage outcome as
  `harness-background-wait`. Do not treat salvage as a successful stage.
- `#1272` solely owns publication and recovery of salvaged work. This change does not create a
  PR and does not change recover-parked, park-release, or `publish_unpublished_stage_commit`
  transitions.
- Prompt single-turn discipline remains as guidance. It is not lifecycle proof.

**BREAKING:** a product-mutating implementer assignment whose adapter declares
`background_job_lifecycle` unsupported now fails preflight with `capability-refusal` instead of
spawning. Planning and review assignments are unchanged.

## Capabilities

### New Capabilities

- `harness-background-job-lifecycle`: Versioned `background_job_lifecycle` capability; typed
  lifecycle event stream; allowlisted evidence; post-completion delivery/join grace; distinct
  `harness-background-wait` termination; no same-adapter retry; salvage retained without a
  successful-stage outcome.

### Modified Capabilities

- `cli-harness-adapters`: Every registered adapter declares `background_job_lifecycle` support or
  non-support. Conformance fails an omitted declaration. Mutating implementation preflight
  refuses unsupported adapters with `capability-refusal`. Planning and review do not require the
  capability.
- `autonomous-recovery-controller`: Closed `pipeline/stage-diagnostic@1` reason vocabulary gains
  additive member `harness-background-wait`. Projection is mechanical from typed lifecycle
  evidence, not from `timed_out`, silence, or transcript wording. Same-adapter retry of the same
  invocation fingerprint is forbidden.
- `harness-uncommitted-salvage`: The existing salvage path still runs and retains evidence when
  this class ends a mutating harness. Salvage does not convert the outcome into a successful
  stage or into `harness-timeout`.
- `single-turn-harness-discipline`: Prompt foreground / single-turn text remains. Engine
  permission for lifecycle-tracked background jobs is not a prompt-text violation. Prompt wording
  is never used as proof of a background wait.
- `production-treatment-fingerprint`: The stable capability hash includes the versioned
  `background_job_lifecycle` declaration so support vs non-support is part of treatment identity.

## Acceptance criteria

- [ ] A supporting adapter that starts a background job, then emits typed complete/fail, then
      delivers and foreground-joins within the effective grace, completes the harness without
      `harness-background-wait` or `harness-timeout`.
- [ ] A supporting adapter whose job is still running (typed start, no complete/fail) continues
      until the remaining `implementation_timeout` and, if that cap fires first, ends as
      `harness-timeout`, not `harness-background-wait`.
- [ ] A supporting adapter that emits typed complete or fail, then does not deliver or
      foreground-join within the effective grace, ends as `harness-background-wait` **before**
      the outer `implementation_timeout`, with allowlisted lifecycle evidence only.
- [ ] Transcript wording and generic inactivity never produce `harness-background-wait`.
- [ ] Malformed or duplicate lifecycle events do not invent a join and do not leak raw command,
      tool output, prompt, or secret text into evidence.
- [ ] Every built-in adapter declares support or non-support. Conformance fixtures include
      historical Claude `#547` evidence and the new incident adapter provenance. An adapter whose
      raw protocol cannot prove lifecycle state is explicitly unsupported.
- [ ] Mutating implementation work (implement, fix-round, test-fix, eval-fix, visual-fix)
      assigned to an unsupported adapter fails preflight with `capability-refusal` and does not
      spawn. Planning and review on that adapter still spawn.
- [ ] Missing delivery/join is not reported as `harness-timeout` and does not retry the same
      adapter for the same invocation fingerprint. Another adapter is selected only under existing
      explicit harness policy.
- [ ] When uncommitted owned work exists, the existing salvage path runs and retains evidence, and
      the stage outcome stays `harness-background-wait`. This change does not open a PR, does not
      transition to `review-1`, and does not alter recover-parked or park-release.
- [ ] Unit tests inject adapter event streams (no real network, git, or subprocess) for: valid
      join; legitimate long-running job; completed-but-undelivered; unjoined; malformed/duplicate
      events; capability refusal; bounded termination before outer timeout; redaction; salvage;
      no same-adapter retry.
- [ ] After any `core/` edits, `plugin/` is regenerated; `openspec validate harness-background-job-lifecycle`
      and `npm run ci` pass.

## Impact

- `core/scripts/harness-adapters/types.ts`: versioned `background_job_lifecycle` on
  `AdapterCapabilities` / declaration; typed lifecycle event schema.
- Built-in adapters (`claude`, `codex`, `grok`, `pi`, `opencode`) plus extension/compatibility
  adapters: explicit support or non-support; protocol verification recorded; no invented events.
- Shared conformance kit and fixtures: `#547` Claude evidence plus the new incident adapter
  provenance.
- Preflight / stage dispatch for product-mutating implementer invocations.
- Harness invoke / round supervisor: consume lifecycle events; enforce join grace; terminate with
  `harness-background-wait` before the outer timeout when join evidence is missing.
- `core/scripts/stage-diagnostic.ts` and `escalation-classify.ts`: additive reason code and total
  projection. Mechanical classification from typed flags/events, not prose.
- Salvage call sites: still run; do not treat this outcome as a successful harness or as
  `harness-timeout` publish.
- Treatment fingerprint capability hash includes the new declaration field.
- Tests under `core/test/` with injectable event streams.
- Generated `plugin/` mirror after any `core/` edit.
- No merge stage, no `auto_merge`, no `#1272` publish/recovery wiring, no raising
  `implementation_timeout` as the fix.
