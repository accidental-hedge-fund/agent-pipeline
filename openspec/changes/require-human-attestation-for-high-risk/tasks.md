## 1. Configuration schema and types

- [ ] 1.1 Add `pre_code_attestation` types and defaults in `core/scripts/types.ts` (enabled, triggers, extra_triggers, thresholds, expiration, approvers, separation_of_duties, wait)
- [ ] 1.2 Add strict zod sub-schema on `PartialConfigSchema` in `core/scripts/config.ts`; reject unknown keys; document defaults when block omitted
- [ ] 1.3 Wire generated config reference / docs examples for `pre_code_attestation` (and regenerate docs if `generate-docs` is present)
- [ ] 1.4 Unit tests: absent block → disabled; valid subset parse; unknown key throws; invalid wait mode throws; invalid trigger enum throws

## 2. Pure trigger evaluation

- [ ] 2.1 Implement `evaluatePreCodeAttestationTrigger` pure helper (no network/git/subprocess) over labels, plan/dossier surface, thresholds, armed classes, extra_triggers
- [ ] 2.2 Define built-in class → path/label/size match tables for architecture, auth, storage, migration, public-api, large-diff
- [ ] 2.3 Unit tests: gate-disabled; no-trigger-matched; each built-in class match with evidence; extra_triggers; threshold large-diff; purity/repeatability

## 3. Design dossier schema and validation

- [ ] 3.1 Define schema-versioned dossier types (intent, boundary, sequence, delta, key contracts, slices)
- [ ] 3.2 Validate behavior diffs (`addition|change|removal`), behavioral contracts (preconditions, input, expected outcome, ownership, failure/retry/concurrency, origin, verification)
- [ ] 3.3 Enforce stated vs derived; derived requires accept/reject before approval eligibility
- [ ] 3.4 Enforce verification ref or `Untestable:` reason; untestable requires human affirmation field at approve time
- [ ] 3.5 Derive compact objective manifest (`objective_id` + content hash) from accepted contracts without a second planning SM
- [ ] 3.6 Unit tests: complete dossier passes; missing slices fail; bad op fails; derived pending blocks; untestable without affirmation blocks; stated path ok

## 4. Approver resolution and separation of duties

- [ ] 4.1 Implement ordered rule resolution (`identity`, `group_ref`, `role`, `path_owner`, risk-class scope) with injectable identity/ownership adapters
- [ ] 4.2 Require coverage of every affected (component × risk class) obligation; unresolved ownership fails closed
- [ ] 4.3 Implement SoD checks against attributed implementer/dossier_author roles when enabled
- [ ] 4.4 Unit tests: identity match; unauthorized; unresolved ownership; group_ref via fake adapter; SoD block; SoD disabled self-attest; provider-optional path without CODEOWNERS

## 5. Attestation records, invalidation, and bypass resistance

- [ ] 5.1 Define attestation record shape (actor, identity source, authorization evidence, timestamp, expires_at, scope, decision, dossier hash, policy hash)
- [ ] 5.2 Currency checks: dossier hash, policy hash, ownership mapping, scope/risk classification, expiry
- [ ] 5.3 Reject silent approve paths (agent plan-review only, markers only, model prose, unauthenticated)
- [ ] 5.4 Unit tests: approve fields complete; reject no advance; invalidation on dossier/policy/scope/expiry; bypass resistance matrix

## 6. Stage wiring and state machine

- [ ] 6.1 Insert `pre-code-attestation` into `STAGES` between `plan-review` and `implementing`; update labels/dispatch
- [ ] 6.2 Implement stage handler: evaluate trigger → inert skip or require dossier + attestation; injectable deps
- [ ] 6.3 Durable wait/human-input request for pending attestation; resume path verifies current approve
- [ ] 6.4 Block `implementing` entry when triggered without current approve
- [ ] 6.5 Unit tests: disabled pass-through; untriggered pass-through; triggered without attest holds; approve advances; STAGES order assertions

## 7. Escalation inventory and wait modes

- [ ] 7.1 Register all new production escalation emitters in the escalation-site inventory with closed dispositions
- [ ] 7.2 Integrity sites deliberately-fail-closed; wait sites use durable hold; no new permanent park class
- [ ] 7.3 Implement `wait.mode` resume_safe vs hard_block; neither silent-approves
- [ ] 7.4 Drift-guard still fails on missing inventory rows; unit tests for wait exhaustion outcomes

## 8. Evidence bundle, evidence_subject, and traceability

- [ ] 8.1 Write pre-code attestation section on every run that reaches the stage (including inert reasons)
- [ ] 8.2 Bind attestation/dossier currency to shared `evidence_subject` / policy_hash rules
- [ ] 8.3 Emit contract-to-evidence trace rows for approved objectives; fail safely on missing verification without untestable exception
- [ ] 8.4 Ensure `Untestable:` rows stay `unverified_exception` and never `test_proven`
- [ ] 8.5 Unit tests: inert record; approve record; reject/unauthorized preserved; trace verified/missing/untestable; policy mismatch invalidation

## 9. Operator surfaces and authority vocabulary

- [ ] 9.1 Document `pre_code_attestation` in config docs with examples; distinguish from plan-review and design-gate
- [ ] 9.2 Update host skill / concepts authority language so plan-review is not re-equated with human sign-off
- [ ] 9.3 Confirm plan-review authority drift-guard still passes; extend only if new forbidden phrases appear
- [ ] 9.4 Eval multi-change: keep optional #575 treatment when configured; absence does not block bare-vs-pipeline

## 10. CI, mirror, and OpenSpec

- [ ] 10.1 Co-located unit tests under `core/test/` covering the acceptance matrix (config, trigger, diffs, derived, untestable, dossier completeness, approvers, SoD, identity mismatch, traceability, invalidation, bypass, approve/reject/recovery)
- [ ] 10.2 Run targeted core tests for new modules
- [ ] 10.3 If `core/` changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [ ] 10.4 `openspec validate require-human-attestation-for-high-risk` and `npm run ci` green
)
