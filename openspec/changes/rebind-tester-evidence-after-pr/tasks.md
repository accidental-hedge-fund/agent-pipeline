## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add a fixture: implementing test gate passes before PR creation; Tester is written for SHA S without `evidence_subject` because trusted-surface is not yet candidate-observable; then a linked PR exists with head S and trusted-surface for S is `passthrough` or `rebound`; the next consumer delivery-stage observer runs. Assert the test **fails** against current code if that observer refuses `required implementation evidence role, observed missing`. Inject I/O; no live network, git, or subprocess
- [x] 1.2 Add a fixture that supplies Tester evidence only for pre-push SHA A while the final PR head is B (A ≠ B), or a blocked trusted-surface decision. Assert the test **fails** against current code if the path reports current implementation-role evidence for B or writes a fabricated subject on blocked trusted-surface
- [x] 1.3 Add a fixture where push succeeds but PR head is missing or not a 40-character SHA, or trusted-surface cannot resolve to `passthrough`/`rebound` with a verifier pin. Assert the test **fails** against current code if the consumer stage is treated as verified or if the only reason is generic `observed missing` with no typed blocker code
- [x] 1.4 Add a recovery fixture for the evidence-ordering diagnostic (consumer missing implementation role after PR-backed same-SHA `passthrough`/`rebound`). Assert the test **fails** against current code if `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, or `publish_unpublished_stage_commit` is started or charged

## 2. Post-PR bind or reproduce (primary)

- [x] 2.1 On the shared `runAdvance` path, after implementing has pushed and a linked PR exists, re-resolve trusted-surface for the live PR head and bind or reproduce SHA-matched Tester evidence **before** the next consumer `observeEvidence("before")`. Nested advance, `single`, `loop`, and FRG SHALL share this path. Verify task 1.1 now fails for the missing-role refuse only if the bind did not run
- [x] 2.2 When SHA-matched Tester evidence for the final PR head S already records a suite pass and trusted-surface is `passthrough` or `rebound` with a trustworthy verifier pin, bind `evidence_subject` and implementation role onto that record. Do not require a second suite command. Reuse `writeTesterEvidence` / `buildTesterEvidence`. Verify `candidate_sha` equals S and subject `verifier_fingerprint` binds to the effective verifier hash
- [x] 2.3 When no SHA-matched current Tester record exists for the final PR head, reproduce via the existing deterministic producer and persist subject + implementation role. Verify a missing/stale/malformed-for-S fixture writes a new SHA-matched record rather than blessing SHA A
- [x] 2.4 Never bless pre-push SHA, stale SHA, all-zero trusted-surface sentinel, or blocked-surface fabricated subject. Verify task 1.2 now passes
- [x] 2.5 If PR head or trusted-surface identity cannot be observed after push, persist a typed actionable blocker and do not enter the consumer stage as verified. Verify task 1.3 now passes

## 3. Consumer observer consumption

- [x] 3.1 Extend `createDeliveryStageEvidenceObserver` so a consumer stage that requires `implementation` treats SHA-matched Tester evidence with well-formed `evidence_subject` and implementation role as proving that role for the observed candidate SHA. Keep exact product-path proof sufficient. Verify task 1.1 now passes
- [x] 3.2 Keep `completingEvidenceBindingFailure` in force: subject-less Tester, SHA mismatch, and planning-role artifacts SHALL still refuse. Verify existing adapter binding tests still pass and a planning-only fixture still cannot complete design-gate
- [x] 3.3 Confirm ordinary advance, nested advance, `single`, `loop`, and FRG enter the same observer after the same bind (shared `runAdvance` / injected observer seam). Verify a nested-advance fixture does not skip the bind

## 4. Recovery recipe (diagnostic-scoped)

- [x] 4.1 Add catalogue recipe `rebind_tester_evidence_after_pr` (name locked by tests) that executes the same shared bind-or-reproduce. Keep class `workflow-engine-defect`. Do not add a new `DurableBlockerClass`. Verify policy compilation still covers every class
- [x] 4.2 For the structured evidence-ordering diagnostic, mark `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, and `publish_unpublished_stage_commit` inapplicable (skip, not claimed, not charged). Claim the rebind recipe when budget remains. Classify from structured fields, not prose. Verify task 1.4 now passes
- [x] 4.3 If rebind still cannot observe PR head or trusted-surface, fail closed with the typed blocker. Do not mark the consumer stage complete. Do not invent a subject. Verify a blocked-TS recovery fixture does not report recovered

## 5. Gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated host SKILL / `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 5.2 Run `openspec validate rebind-tester-evidence-after-pr` and `npm run ci` from the repo root. Verify both are green. Do not weaken delivery-stage binding, trusted-surface, review, merge, or FRG. Do not add an `auto_merge` key or merge stage
