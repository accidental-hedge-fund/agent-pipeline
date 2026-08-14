## 1. Config schema and types

- [ ] 1.1 Add strict `override_governance` sub-schema (schema_version, classes map, per-class max_duration_hours, approvers, required_evidence, separation_of_duties, renewal mode + require_human_on, optional default_class) to config types and `PartialConfigSchema`
- [ ] 1.2 Define implicit low-risk compatibility defaults when the block is omitted; document defaults next to schema
- [ ] 1.3 Reject unknown keys, unknown class ids, invalid durations, and invalid renewal modes at parse time with clear errors
- [ ] 1.4 Unit tests: parse accept/reject matrix for `override_governance` (including omitted-block compatibility)

## 2. Decision model and pure evaluators

- [ ] 2.1 Add versioned override decision types (decision_id, class, target, actor, authorization, evidence_refs, evidence_subject, fingerprint/region, created_at, expires_at, lifecycle, lineage)
- [ ] 2.2 Implement pure `evaluateOverrideValidity` (injectable `now`, pin subject, live finding/scope context, effective policy)
- [ ] 2.3 Implement active projection over append-only decisions (latest valid active per target; supersession/renewal lineage)
- [ ] 2.4 Implement renewal-lite eligibility (fingerprint + code region + subject currency + prior auth still holds)
- [ ] 2.5 Unit tests: authorization refuse, expiry, subject drift invalidation, scope mismatch, SoD, supersession, renewal-lite success/fail, append-only (no in-place mutate)

## 3. Authority resolution

- [ ] 3.1 Reuse #575-style approver rule kinds plus trusted_override_actors continuity for class authorization
- [ ] 3.2 Fail closed when actor is null/unauthenticated
- [ ] 3.3 Enforce per-class separation_of_duties when enabled
- [ ] 3.4 Unit tests: identity/group/role/allowlist match and miss; SoD forbid implementer

## 4. Record path (CLI + comments)

- [ ] 4.1 Extend override CLI parse for optional class token while keeping bare `"<key|scope>: <reason>"` → default/implicit class mapping
- [ ] 4.2 Enforce required evidence/remediation refs by class before post
- [ ] 4.3 Build engine `evidence_subject` at record time; capture fingerprint and code region
- [ ] 4.4 Post audited comments with backward-compatible sentinels plus structured decision fields (dual-read old sentinels)
- [ ] 4.5 Refuse path: no post, no label flip, clear error + rejected event/record
- [ ] 4.6 Unit tests: parse forms, missing evidence, unknown class, successful record field set

## 5. Wire into partition and auto-resume

- [ ] 5.1 Change `partitionFindings` / override extraction consumers to use validity-gated active projection
- [ ] 5.2 Preserve key ambiguity guard and scoped multi-match semantics under validity gating
- [ ] 5.3 Gate auto-resume so refused/invalid decisions do not clear blockers or advance
- [ ] 5.4 Preserve stop-at-ready-to-deploy / no-merge on successful resume
- [ ] 5.5 Unit tests: expired/invalidated do not deblock; valid deblocks; auto-resume refuse vs success

## 6. Renewal, events, evidence bundle

- [ ] 6.1 Implement lite renewal append (new decision_id, renewed_from, new expires_at; prior immutable)
- [ ] 6.2 Implement human renewal path (full auth + evidence for class mode `human`)
- [ ] 6.3 Emit machine-readable events: recorded, rejected, superseded, renewed_lite, renewed_human, expired, invalidated
- [ ] 6.4 Extend evidence-bundle / OverrideRecord surface with lifecycle, class, lineage, authority summary
- [ ] 6.5 Unit tests: renewal does not mutate prior expiry; event field presence; evidence lifecycle distinction

## 7. Escalation inventory and operator docs

- [ ] 7.1 Add inventory rows for unauthorized/SoD/missing-evidence/unknown-class refusals (`deliberately-fail-closed`)
- [ ] 7.2 Add inventory rows for expiry/invalidation/drift-blocked lite renewal (typed reason; not transient-retryable; no new park class)
- [ ] 7.3 Document `override_governance` in config reference / examples (low-risk + high-risk)
- [ ] 7.4 Update operator-facing override help text for class syntax and compatibility path

## 8. Integration gate

- [ ] 8.1 Run targeted unit tests for new modules and review-policy/override paths
- [ ] 8.2 Regenerate `plugin/` via `node scripts/build.mjs` if `core/` changed; include mirror in the same commit
- [ ] 8.3 Run `npm run ci` from repo root and fix until green
- [ ] 8.4 Confirm OpenSpec change still validates (`openspec validate governed-typed-overrides`)
