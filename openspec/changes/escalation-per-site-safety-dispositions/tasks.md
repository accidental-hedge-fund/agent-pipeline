## 1. Disposition inventory and drift guards (behavior-neutral first)

- [ ] 1.1 Add a machine-readable escalation-site inventory module under `core/scripts/` with closed
      disposition enum `deliberately-fail-closed` | `transient-retryable` | `reconcile-owned` and
      stable site ids.
- [ ] 1.2 Seed the inventory from the 2026-07-31 census plus a ripgrep of production `setBlocked`,
      `needs-human` transitions, and authority-class `emitHumanIntervention` call sites (include
      getGhActor, push, worktree-missing, label mutation, format park, and review non-convergence
      surfaces).
- [ ] 1.3 Per-site decide disposition using call-site use of the result (attestation fail-closed vs
      probe/transient vs reconcile-owned); record notes and canonical reason projection.
- [ ] 1.4 Implement a disposition drift-guard test that fails when a new production escalation
      emitter lacks an inventory row (default unknown → fail-closed for wrapper eligibility).
- [ ] 1.5 Implement an authority drift-guard test that fails when production `needs-human` /
      authority-class `human_intervention` paths bypass the canonical authority predicate without a
      reporting-only exemption.

## 2. Canonical reason vocabulary evolution and projections

- [ ] 2.1 Evolve `STAGE_DIAGNOSTIC_REASON_CODES` / `buildStageDiagnostic` / `projectPipelineReasonCode`
      with the smallest additive set that preserves non-lossy classification for harness timeout,
      harness-contract, transient infrastructure, external-wait, repair-budget-exhausted, and
      human-context (or map into existing codes + structured detail where non-lossy).
- [ ] 2.2 Implement mechanical classifiers from `HarnessResult` flags and gh error shapes; unit-test
      pure mapping without prose-primary classification.
- [ ] 2.3 Add exhaustiveness tests: every reason code → exactly one `DurableBlockerClass` (or
      protocol failure); loop recovery budget/policy keys accept only that closed set.
- [ ] 2.4 Wire `HumanInterventionKind` and `PreMergeOfframpClass` as pure projections; ensure
      `review-non-convergence` cannot alone create human authority.
- [ ] 2.5 Add regression: gh HTTP 504 on a label-edit path classifies transient and does not project
      to product human authority.

## 3. Bounded wrappers for transient-retryable sites

- [ ] 3.1 Ensure transient-retryable gh read/label mutation sites use `ghRun` / shared transient
      wrapper; injected-deps tests for 5xx retry success, 5xx exhaustion (engine-owned), and
      deterministic 422 no-retry.
- [ ] 3.2 Add push wrapper with currency re-sync check (no force-push); wire inventory-listed
      zero-retry push sites; injected-deps tests for retry-after-blip and refuse-on-head-drift.
- [ ] 3.3 Wire remaining worktree-missing first-hop parks through rematerialize after dirty-work
      check; tests for success-continue, dirty-refuse, capacity kind.
- [ ] 3.4 Implement bounded pipeline-owned format self-fix (commit subject, impl ref, verdict
      sections) with hard attempt cap; tests for rewrite-success and exhaust-engine-owned; prove
      human prose is not rewritten.
- [ ] 3.5 Confirm deliberately-fail-closed attestation `getGhActor` sites remain zero-retry with
      regression tests.

## 4. Stage integration and non-regression

- [ ] 4.1 Update fix / planning / pre-merge / shipcheck / review-routing callers to honor inventory
      dispositions without expanding review blocking policy.
- [ ] 4.2 Preserve #787/#814 review-findings recovery path: recurrence/ceiling stay engine-owned
      `remediate → re-review`; no blind review replay; no human hold without authority evidence.
- [ ] 4.3 Ensure mechanical recovery exhaustion paths emit typed engine-owned outcomes only (no
      `human_intervention` solely from exhaustion).
- [ ] 4.4 Leave `reconcile-owned` sites as typed escalate-only with ownership notes; do not
      implement #759 reconciler behavior in this change.

## 5. Generated artifacts and verification

- [ ] 5.1 Run `node scripts/build.mjs` and commit regenerated `plugin/` alongside `core/` edits.
- [ ] 5.2 Run `npm run ci` from repo root and fix failures until green.
- [ ] 5.3 Prove key regression tests bite (504 label path; disposition drift guard; authority drift
      guard; attestation fail-closed) by confirming they fail without the fix logic where practical.
)