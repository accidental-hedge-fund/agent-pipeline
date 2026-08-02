## 1. Contract registry and pure validators

- [x] 1.1 Add a stage-output-contract module under `core/scripts/` with a versioned registry API (id, version, kind, validate, optional repairAddendum, gated side-effect documentation).
- [x] 1.2 Register `plan-revision.ack@1` wrapping existing `verifyPlanRevisionOutput` tolerances (mid-line, fence, multi-header) without behavior regression on accept/reject cases.
- [x] 1.3 Register `openspec.change-singular@1` wrapping `enforceOpenspecChangeSingular` (or equivalent pure check) for filesystem-shape singularity.
- [x] 1.4 Register `review.verdict@1` reusing `review-schema.ts` / production parsers (no forked schema text); distinguish unparseable shape from valid empty findings.
- [x] 1.5 Unit-test pure validators with injectable fixtures; no network/git/subprocess in those tests.

## 2. Shared format-repair policy

- [x] 2.1 Implement a single shared format-repair helper (default budget: one re-prompt; two validation attempts total) that takes validate + invoke + repair addendum.
- [x] 2.2 Ensure the helper does not perform a second automatic repair under the default budget and returns a structured terminal failure when exhausted.
- [x] 2.3 Migrate plan-revision off `PLAN_REVISION_FORMAT_REPAIR_ADDENDUM` private loop onto the shared helper (thin contract-specific addendum only).
- [x] 2.4 Wire OpenSpec singularity failures through the same shared repair policy before terminal block.
- [x] 2.5 Wire review unparseable-shape path through the same shared repair policy where the stage currently hard-fails pure parse/schema shape (without changing severity policy for valid verdicts).

## 3. Terminal harness-contract diagnostics

- [x] 3.1 On pure shape failure after shared repair exhaustion, emit `pipeline/stage-diagnostic@1` with reason `harness-contract` (no new parallel enum).
- [x] 3.2 Replace plan-revision terminal `needs-human` for pure ack shape exhaustion with harness-contract projection; keep harness process failures on their existing mechanical paths.
- [x] 3.3 Regression-test autonomous-recovery / stage-diagnostic projection: harness-contract after repair exhaustion is engine-owned, not human_authority.

## 4. Layering: envelope vs product schema

- [x] 4.1 Document and enforce in code/tests that adapter envelope normalization runs before stage-output-contract validation when both apply.
- [x] 4.2 Add a regression guard that fails if stage-output validation acceptance branches on harness/provider name.

## 5. Golden fixtures and extension hook

- [x] 5.1 Check in golden fixtures: Grok mid-line ack (accept), Claude line-start ack (accept), review fenced JSON verdict (accept), OpenSpec multi-change (reject).
- [x] 5.2 Drift-guard tests that call production validate functions on those fixtures.
- [x] 5.3 Add extension-adapter golden-fixture registration/discovery hook aligned with adapter identity; test that extension fixtures hit the same central validate path.
- [x] 5.4 Optionally register remaining schema-backed stages (shipcheck, design interrogation/response, auto-merge judge) in this change when low-cost; otherwise list explicit follow-ups with issue links and a test that the follow-up list cannot grow silently.

## 6. Shared harness-round integration

- [x] 6.1 If shared-round consumers gain registered stdout contracts, call the shared format-repair policy from the shared stack rather than private loops.
- [x] 6.2 Confirm non-round stages (plan-revision, OpenSpec authoring) use the same helper without being forced into commit-producing shared-round migration solely for repair.

## 7. Drift guards, mirror, and CI

- [x] 7.1 Add registry completeness drift tests for the minimum in-scope contract ids.
- [x] 7.2 Add tests that bite when validation is skipped before posting a revised plan or advancing past multi-change OpenSpec authoring.
- [x] 7.3 Prove repair-budget test bites (fails if a second automatic repair is introduced or if plan-revision private full loop returns).
- [x] 7.4 Run `node scripts/build.mjs` and commit regenerated `plugin/` when `core/` changes.
- [x] 7.5 Run `npm run ci` from repo root and fix all failures until green.
