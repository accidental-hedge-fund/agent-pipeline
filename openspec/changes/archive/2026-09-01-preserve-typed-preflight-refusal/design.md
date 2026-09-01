## Context

See proposal.md for motivation. After #1364 / PR #1365:

- `runProductionPreflight` refuses only a missing `background_job_lifecycle` object on mutating `stageKind`. Explicit `{ supported: false }` proceeds to spawn. The lifecycle supervisor stays off when `supported !== true`.
- `backgroundJobLifecycleCoherenceFailure` already classifies malformed declarations, but production preflight does not call it. Conformance still fails those adapters at kit time.
- `harness.invoke` already returns `preflight_failed`, `preflight_class`, `preflight_reason_code`, and `preflight_intervention_kind` with `exit_code: -1` and no `buildInvocation` / spawn.
- `invokeFixHarnessWithRetry` already returns after the first `preflight_failed` result. `classifyHarnessFailure` maps `preflight_reason_code: capability-refusal` before the exit-code fallback.
- Implement, test-fix, eval-fix, and visual-fix still format a failed invoke as `exit ${exit_code}` unless `background_wait` or `timed_out` is set. A typed refusal therefore becomes `exit -1` on those stages.
- Recovery for flattened `workflow-engine-defect` selects `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, and related recipes. `filterRecipesForHarnessBackgroundWait` already exists as the same-adapter wait filter.

#1323 RecoverySupervisor is vocabulary and a forthcoming sole owner. This change does not implement that module.

## Goals / Non-Goals

**Goals:**

- Stop at the first holding reuse rung: existing typed `HarnessResult` fields, `classifyHarnessFailure`, `buildStageDiagnostic`, `backgroundJobLifecycleCoherenceFailure`, `sanitizePreflightDiagnostic`, and the recipe-filter pattern.
- Close the remaining flatten/retry/recipe gaps after the #1365 audit.
- Keep #1364 `supported: false` compatibility tests authoritative.

**Non-Goals:**

- A new RecoverySupervisor, observation bus, durable blocker class, or retry framework.
- Reverting #1364 / PR #1365.
- Implicit adapter fallback, merge, release, or destructive-operation authority.
- Changing crash and timeout retry budgets.
- Inventing harness sessions or lifecycle events for unsupported adapters.

## Decisions

### D1: Audit first; no no-op PR

**Decision:** Implementation starts with a written audit of remaining genuine refusal paths against current tests. If every acceptance criterion is already proven, close #1362 with the covering commit SHAs and tests. Do not land a comment-only or identity PR.

**Rationale:** The issue states this explicitly. #1365 already landed one-shot fix-round refusal and `supported: false` spawn.

**Alternatives:** Always ship a PR (rejected: empty diffs waste review). Skip the audit (rejected: risk of re-refusing `supported: false`).

### D2: Call existing coherence helper from production preflight

**Decision:** On mutating `stageKind`, after the omitted-object check, call `backgroundJobLifecycleCoherenceFailure` on the declared lifecycle. A non-null message is `capability-refusal` with `unsupported-setting`, before executable resolution and `adapter.preflight`. Do not add a second parser.

**Rationale:** First holding rung. Conformance already uses that helper. Production invoke must fail closed for a registered-but-malformed adapter the same way it fails for omitted.

**Alternatives:** Conformance-only (rejected: a force-registered malformed adapter can still reach invoke). New malformed enum (rejected: existing `unsupported-setting` + `capability-refusal` already name it).

### D3: Preserve typed fields at stage consumers; do not invent a shared retry wrapper

**Decision:** Where a mutating stage formats a failed `HarnessResult` as `exit ${exit_code}`, check `preflight_failed` first (same order as `background_wait` / `timed_out`). Use `classifyHarnessFailure` + `buildStageDiagnostic` and the sanitized stderr / remediation message. Keep `invokeFixHarnessWithRetry` as the only crash-retry loop. Do not wrap implement / test-fix / eval-fix / visual-fix in that loop.

**Rationale:** The flatten bug is at the consumer. A new shared retry helper would be a custom layer. Fix-round already has the one-shot exception.

**Alternatives:** Extract a new `formatHarnessFailureReason` module used by every stage (possible later; not required to close the bug). Retry implement the same way as fix (rejected: out of scope; implement has its own salvage/publish path).

### D4: Recipe filter for never-started harness, same pattern as background-wait

**Decision:** When the observation is a typed production-preflight refusal (`preflight_failed` and no spawn), filter out `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, `publish_unpublished_stage_commit`, force-push, and worktree-removal. Empty remaining recipes are not exhaustion. Mechanical `capability-refusal` stays `recover`, not `human_authority`.

**Rationale:** `filterRecipesForHarnessBackgroundWait` is the existing pattern. Flattened classification is the usual path into engine-scratch recipes; filtering is the belt if classification ever regresses. Inapplicable recipes must not consume the exhaustion budget.

**Alternatives:** Rely only on correct `capability-refusal` → `environment-auth` / `verify_authentication` projection (necessary but not sufficient if a consumer still emits `workflow-engine-defect`). New RecoverySupervisor (rejected: #1323 is out of this issue; report through existing diagnostic fields).

### D5: Mechanical routing vs CapabilityRequest vs wait

**Decision:** Omitted or malformed required lifecycle is mechanical routing: typed `capability-refusal`, engine-owned recover, never human authority. Missing CLI / unauthenticated stays `environment-auth` with `verify_authentication` (external-condition wait). A true unavailable capability that needs operator-supplied input uses the existing `CapabilityRequest` / handoff path. Do not emit a new grill `CapabilityRequest` from the fix/implement invoke path.

**Rationale:** Classification never grants merge, release, destructive, security, or fallback authority. Product failure classification is not a new request type.

**Alternatives:** Park every capability-refusal as needs-human (rejected: false human). Map omitted declaration to CapabilityRequest (rejected: the operator cannot supply a field the adapter omitted; that is engine/config routing).

### D6: Durable evidence reuses sanitizer; no prompt payload

**Decision:** Record `preflight_failed`, `preflight_class`, `preflight_reason_code`, `preflight_intervention_kind`, and the already-bounded sanitized message on the stage diagnostic / evidence record. Reuse `sanitizePreflightDiagnostic`. Do not copy prompt text, argv, or secrets into that record.

**Rationale:** The sanitizer and HarnessResult fields already exist. Evidence-bundle prompt records stay on their existing redacted path and are not the refusal diagnostic.

**Alternatives:** New evidence schema version (rejected: additive fields on the existing diagnostic/outcome are enough).

## Risks / Trade-offs

- **[Risk] Audit concludes the issue is already done except other-stage flatten.** → Mitigation: implement only the remaining consumer/filter/coherence gaps; keep #1364 tests; do not reopen spawn-refuse-unsupported.
- **[Risk] Filtering worktree recipes leaves capability-refusal with no recipe.** → Mitigation: that is owned wait/recover on the typed diagnostic, not exhaustion. `verify_authentication` stays for `environment-auth`. Mechanical capability-refusal does not need scratch unlink.
- **[Risk] Malformed `supported: true` without schema currently spawns if the object exists.** → Mitigation: coherence helper refuses it before spawn. Tests inject a malformed declaration.
- **[Risk] Stage-local reason strings drift again.** → Mitigation: tests on fix-1 and at least one other mutating stage assert typed fields and forbid `exit -1` as the classified reason.

## Migration Plan

No config, label, or schema migration. Behavior is additive on existing fields. Rollback is revert of the change. #1364 compatibility tests MUST remain green across the change.

## Open Questions

None. Remaining work is the audit-then-patch sequence in tasks.md.
