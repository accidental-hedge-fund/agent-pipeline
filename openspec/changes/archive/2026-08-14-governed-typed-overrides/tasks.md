## 1. Config schema and types

- [x] 1.1 Add strict `override_governance` sub-schema (schema_version, classes map, per-class max_duration_hours, approvers, required_evidence, separation_of_duties, renewal mode + require_human_on, optional default_class) to config types and `PartialConfigSchema`
- [x] 1.2 Define implicit low-risk compatibility defaults when the block is omitted; document defaults next to schema
- [x] 1.3 Reject unknown keys, unknown class ids, invalid durations, and invalid renewal modes at parse time with clear errors
- [x] 1.4 Unit tests: parse accept/reject matrix for `override_governance` (including omitted-block compatibility)

## 2. Decision model and pure evaluators

- [x] 2.1 Add versioned override decision types (decision_id, class, target, actor, authorization, evidence_refs, evidence_subject, fingerprint/region, created_at, expires_at, lifecycle, lineage)
- [x] 2.2 Implement pure `evaluateOverrideValidity` (injectable `now`, pin subject, live finding/scope context, effective policy)
- [x] 2.3 Implement active projection over append-only decisions (latest valid active per target; supersession/renewal lineage)
- [x] 2.4 Implement renewal-lite eligibility (fingerprint + code region + subject currency + prior auth still holds)
- [x] 2.5 Unit tests: authorization refuse, expiry, subject drift invalidation, scope mismatch, SoD, supersession, renewal-lite success/fail, append-only (no in-place mutate)

## 3. Authority resolution

- [x] 3.1 Reuse #575-style approver rule kinds plus trusted_override_actors continuity for class authorization
- [x] 3.2 Fail closed when actor is null/unauthenticated
- [x] 3.3 Enforce per-class separation_of_duties when enabled
- [x] 3.4 Unit tests: identity/group/role/allowlist match and miss; SoD forbid implementer

## 4. Record path (CLI + comments)

- [x] 4.1 Extend override CLI parse for optional class token while keeping bare `"<key|scope>: <reason>"` → default/implicit class mapping
- [x] 4.2 Enforce required evidence/remediation refs by class before post
- [x] 4.3 Build engine `evidence_subject` at record time; capture fingerprint and code region
- [x] 4.4 Post audited comments with backward-compatible sentinels plus structured decision fields (dual-read old sentinels)
- [x] 4.5 Refuse path: no post, no label flip, clear error + rejected event/record
- [x] 4.6 Unit tests: parse forms, missing evidence, unknown class, successful record field set

## 5. Wire into partition and auto-resume

- [x] 5.1 Change `partitionFindings` / override extraction consumers to use validity-gated active projection
- [x] 5.2 Preserve key ambiguity guard and scoped multi-match semantics under validity gating
- [x] 5.3 Gate auto-resume so refused/invalid decisions do not clear blockers or advance
- [x] 5.4 Preserve stop-at-ready-to-deploy / no-merge on successful resume
- [x] 5.5 Unit tests: expired/invalidated do not deblock; valid deblocks; auto-resume refuse vs success

## 6. Renewal, events, evidence bundle

- [x] 6.1 Implement lite renewal append (new decision_id, renewed_from, new expires_at; prior immutable)
- [x] 6.2 Implement human renewal path (full auth + evidence for class mode `human`)
- [x] 6.3 Emit machine-readable events: recorded, rejected, superseded, renewed_lite, renewed_human, expired, invalidated
- [x] 6.4 Extend evidence-bundle / OverrideRecord surface with lifecycle, class, lineage, authority summary
- [x] 6.5 Unit tests: renewal does not mutate prior expiry; event field presence; evidence lifecycle distinction

## 7. Escalation inventory and operator docs

- [x] 7.1 Add inventory rows for unauthorized/SoD/missing-evidence/unknown-class refusals (`deliberately-fail-closed`)
- [x] 7.2 Add inventory rows for expiry/invalidation/drift-blocked lite renewal (typed reason; not transient-retryable; no new park class)
- [x] 7.3 Document `override_governance` in config reference / examples (low-risk + high-risk)
- [x] 7.4 Update operator-facing override help text for class syntax and compatibility path

## 8. Integration gate

- [x] 8.1 Run targeted unit tests for new modules and review-policy/override paths
- [x] 8.2 Regenerate `plugin/` via `node scripts/build.mjs` if `core/` changed; include mirror in the same commit
- [x] 8.3 Run `npm run ci` from repo root and fix until green
- [x] 8.4 Confirm OpenSpec change still validates (`openspec validate governed-typed-overrides`)
