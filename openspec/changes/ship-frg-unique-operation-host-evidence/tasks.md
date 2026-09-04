## 1. Control-host unique-operation collection

- [x] 1.1 Point `collectUniqueOperationsFromRunStore` (or its caller in `runFactoryGate`) at the control-host generic run-store root used by factory-release pack-loop scans (`resolveStateHome`), not `repoDir/.agent-pipeline/runs` of the candidate worktree, and verify a hermetic test collects train/merge attempts from an injected host store when the candidate worktree runs directory is empty
- [x] 1.2 Keep `filterAttemptsBoundToCandidate` as the binding filter, and verify other-candidate host runs do not satisfy the scored candidate
- [x] 1.3 Keep fail-closed behavior when the host store is empty or has no candidate-bound train/loop/merge events, and verify `missing_required_coverage > 0` and `isReleaseEligibleFrgPass` is false

## 2. In-flight ship coverage deferral

- [x] 2.1 Change unique-operation aggregation so an in-flight `ship` whose own FRG pack is being scored does not increment `missing_required_coverage` for entrypoint `ship` and does not list `ship` in `entrypoint_coverage.missing`, and verify a regression fails if that gap still fails SLOs
- [x] 2.2 Keep a completed prior `ship` attempt bound to the scored candidate as observed coverage, and verify it does not count as verified success of the in-flight ship
- [x] 2.3 Keep `ship` in `REQUIRED_PUBLIC_ENTRYPOINTS`, and verify missing `train` (or another non-ship required entrypoint) still increments missing required coverage during in-flight ship FRG scoring
- [x] 2.4 Do not record the in-flight `ship` gap as a stable exclusion, and verify exclusions stay empty for that gap

## 3. #1301 host train stream and #1333 seam

- [x] 3.1 Score #1301 live `train_loop_linked` from control-host train events bound to the scored candidate, and verify a host train stream with a followable child `onRunReady` path satisfies linkage when the factory-gate pack loop has no train events
- [x] 3.2 Keep the existing rule that a `train_loop_linked` event with only the parent logical id is not followable child linkage, and verify that case still increments missing correlation or missing required coverage
- [x] 3.3 Pass candidate-bound #1333 executed matrix rows through the existing `runFactoryGate` / aggregator seam when they exist on control-host or engine evidence, and verify helper stamps still fail promotion
- [x] 3.4 Leave #1333 fail-closed when bound executed rows are absent, and verify missing required coverage names that gap rather than a stable exclusion

## 4. Release-eligibility regression and hard-gate text

- [x] 4.1 Add a hermetic regression that fails if `isReleaseEligibleFrgPass` is false when hybrid v2 pack proofs pass, unique-ops come from a host run-store with train+merge coverage bound to the candidate, and no completed `ship` attempt exists for this ship (attestation optional)
- [x] 4.2 Add a hermetic regression that still fails `isReleaseEligibleFrgPass` when the host store is empty and no train events exist, even if pack-issue labels would say ready-to-deploy
- [x] 4.3 Include `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` text in `factory-release prepare` structural-eligibility hard-gate messages, and verify a unit test fails if the message is only the generic structural-eligibility sentence
- [x] 4.4 Keep HMAC attestation required on the tag/promote path, and verify prepare structural eligibility still uses `requireAttestation: false` without skipping later HMAC

## 5. Docs and CI

- [x] 5.1 Update the FRG runbook unique-operation section so it names the control-host evidence root, the in-flight-ship coverage deferral, and the hard-gate diagnostic, and verify those docs no longer imply the candidate worktree run-store is the unique-operation source
- [x] 5.2 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [x] 5.3 Run `openspec validate ship-frg-unique-operation-host-evidence` and `npm run ci` from the repo root, and verify both exit 0
