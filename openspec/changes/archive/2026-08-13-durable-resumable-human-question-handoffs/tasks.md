## 1. Schema, types, and pure validation

- [x] 1.1 Define `HumanQuestionHandoff` v1 types (`schema_version`, identity, question, class, authority_mode, scope hashes, eligibility, lifecycle, answer, resume) in `core/scripts/` (new module e.g. `handoff.ts` / `human-question-handoff.ts`)
- [x] 1.2 Implement pure schema validate / parse helpers that fail closed on missing question, bad class, bad authority_mode, unknown schema_version
- [x] 1.3 Define closed `handoff_class` and status enums; document authority-bearing vs non-authority mapping
- [x] 1.4 Unit tests: complete record validates; empty question fails; unknown schema fails resume eligibility; unknown class rejected; authority/non-authority class matrix

## 2. Create eligibility and authority evidence gate

- [x] 2.1 Implement pure `canCreateHandoff` / `createHandoffRecord` inputs: bounded question, required capability, candidate SHA / artifact hashes, authority evidence
- [x] 2.2 Enforce post-#787 rule: authority-bearing create requires current `human-decision-required` (key, fingerprint, reviewed SHA) or equivalent policy-bound authority gate
- [x] 2.3 Map engine exhaustion without decision question → `manual_repair` + `non_authority` (never masquerade as `product_judgment`)
- [x] 2.4 Unit tests: authority create with diagnostic; authority create without diagnostic fails; manual_repair path; missing SHA fails when tip present

## 3. Durable store and append-only audit

- [x] 3.1 Persist handoffs under issue/run-scoped durable path (injectable fs deps); load by id and list-by-issue/run
- [x] 3.2 Append-only audit log for create/answer/reject/supersede/expire/resume-attempt (including duplicate markers)
- [x] 3.3 Optional pipeline-attested issue comment / sentinel for operator discovery (idempotent update by handoff id)
- [x] 3.4 Unit tests: round-trip store; list filters; audit append; no rewrite of prior answer body

## 4. Eligibility resolution and answer authorization

- [x] 4.1 Pure `resolveHandoffEligibility` reusing #575-style rule kinds via injectable adapters
- [x] 4.2 Pure `authorizeHandoffAnswer`: authority-bearing refuses unidentified/unauthorized; non-authority never upgrades to approval/override/attestation
- [x] 4.3 Unresolved authority routing fails closed with evidence; no invented assignee
- [x] 4.4 Unit tests: eligible answer; unauthorized refuse; unidentified refuse; non-authority distinct from attestation/override; unresolved routing

## 5. Answer, reject, supersede idempotency

- [x] 5.1 Implement answer/reject/supersede state transitions with idempotency keys / payload hash
- [x] 5.2 Reject keeps blocked/needs-human; supersede links ids and blocks resume on old id
- [x] 5.3 Unit tests: duplicate answer; reject no advance; supersede refuse old answer resume; concurrent independent handoffs on different issues

## 6. Resume revalidation

- [x] 6.1 Implement pure `validateHandoffResume` (status, SHA, dossier/policy hashes, expiry, supersession, authorization currency, resume_target, stage preconditions)
- [x] 6.2 Wire refuse paths to preserve labels and record evidence
- [x] 6.3 Unit tests: success path; stale SHA; changed dossier/policy; expired; superseded; ambiguous resume target; malformed record

## 7. Fix-stage human-decision integration

- [x] 7.1 On accepted needs-human-decision park, create/reuse authority-bearing handoff per declaration identity
- [x] 7.2 Keep existing evidence comment and non-advance / non-suppress finding rules
- [x] 7.3 Unit tests: park creates handoff; idempotent re-park; create failure leaves blocker; findings remain blocking

## 8. Operator CLI and command registry

- [x] 8.1 Register `handoff list|show|answer|reject|supersede` (exact names per registry style) with `allowedFlags` including `--json` and filters
- [x] 8.2 Implement handlers using injectable gh/identity/store deps; human-readable + JSON
- [x] 8.3 Unit tests: registry allowlists; list filter by issue/run/repo/batch; show full question; answer/reject/supersede happy and fail-closed paths

## 9. Status, queue, and loop projections

- [x] 9.1 Extend `--status` needs-human surface to list pending handoffs without removing ceiling punch-list
- [x] 9.2 Extend batch-summary with `waiting_human_count` / age; exclude waiting-human from capacity-failure classification; allow other ready dispatches
- [x] 9.3 Loop/supervisor: link authority holds to handoffs; handoff alone does not invent authority without diagnostic
- [x] 9.4 Unit tests: status with/without handoffs; queue waiting counts; ready item continues; diagnostic-gated hold

## 10. Evidence bundle, intervention correlation, escalation inventory

- [x] 10.1 Record handoff lifecycle outcomes in evidence bundle / referenced artifacts
- [x] 10.2 Optionally attach `handoff_id` on related `human_intervention` events without taxonomy churn
- [x] 10.3 Inventory all new production sites in escalation-site dispositions; integrity deliberately-fail-closed
- [x] 10.4 Unit tests: evidence fields; disposition drift-guard still bites on missing rows

## 11. Pre-code attestation composition guard

- [x] 11.1 Ensure non-authority handoff answers cannot clear triggered pre-code attestation
- [x] 11.2 Unit test: triggered gate + context answer still holds implementing

## 12. CI, mirror, and OpenSpec

- [x] 12.1 Co-located tests covering acceptance matrix (all classes, eligible/unauthorized, stale SHA, dossier/policy change, expiry, supersession, duplicate delivery, rejection, ambiguous resume, successful resume, concurrent independent work)
- [x] 12.2 Run targeted core tests for handoff modules
- [x] 12.3 If `core/` changed, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [x] 12.4 `openspec validate durable-resumable-human-question-handoffs` and `npm run ci` green
