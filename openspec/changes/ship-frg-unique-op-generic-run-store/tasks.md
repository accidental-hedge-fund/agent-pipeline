## 1. Dual-root unique-operation collection

- [ ] 1.1 Extend `uniqueOperationRunsRoots` so factory-release / factory-gate unique-operation collection reads the control-host generic run store (`runsDir` of the factory-control / `REPO_DIR` root) **in addition to** the loop state-home `<resolveStateHome()>/runs`, and verify a hermetic test with empty candidate-worktree runs plus populated generic-host runs observes required public entrypoints under `inFlightShip`
- [ ] 1.2 Keep in-flight ship from treating the candidate worktree `.agent-pipeline/runs` as source of truth unless that path is the control-host generic root, and verify candidate-worktree-only artifacts still fail when both host roots are empty
- [ ] 1.3 Pass enough context from `defaultScoreBoundPackLoop` (injected generic root and/or env) that production prepare scores the generic store without a new CLI verb, and verify an in-process score with `inFlightShip: true` and no explicit `uniqueOperationRunsRoot` still reads an injected control-host generic store
- [ ] 1.4 Keep fail-closed behavior when the generic store **and** the loop state-home are both empty, and verify `missing_required_coverage > 0` and `isReleaseEligibleFrgPass` is false even if pack-issue labels say ready-to-deploy

## 2. In-flight unbound keep and attempt mapping

- [ ] 2.1 Extend `filterAttemptsBoundToCandidate` (or its in-flight-ship caller) so in-flight ship keeps attempts that lack `candidate_sha` and lack release identity, and verify unbound train/loop artifacts are kept for `inFlightShip: true` and dropped for standalone factory-gate
- [ ] 2.2 Keep dropping other-candidate SHAs and present mismatched release identities during in-flight ship, and verify those artifacts still cannot satisfy the scored candidate
- [ ] 2.3 Extend `attemptsFromRunArtifacts` so a recognized public entrypoint comes from `run.json.kind`, `run_start.entrypoint`, or a stable run-id prefix (`train-`, `loop-`, `merge-` / `mq-` / `merge-queue-`, numeric drive), and verify prefix-only artifacts observe `train`, `loop`, `merge-queue`, and `drive` while `kind: "advance"` is not coerced to `single`
- [ ] 2.4 Use `run_id` as aggregation identity when the artifact has no `logical_operation_id`, and verify that fallback does not count as verified unique-operation success
- [ ] 2.5 Treat in-flight kept fallback-identity host artifacts as entrypoint coverage observation so they do not increment `missing_correlation` or `ownerless_terminal` solely for a missing minted id / missing postcondition proof, and verify a regression fails if those counts rise for prefix-only unbound train/loop artifacts under `inFlightShip`

## 3. In-flight #1333 inventory rows

- [ ] 3.1 When `inFlightShip` is true and `assertFaultRecoveryInventoryComplete` passes for the candidate tree's `FAULT_RECOVERY_MATRIX`, attach `executed_matrix_rows` bound to the scored candidate SHA and pass them through `bindExecutedMatrixRowsForCandidate`, and verify all five #1333 lifecycle classes become covered
- [ ] 3.2 Do not stamp `passingUniqueOperationManifest().covered_lifecycle_classes`, and verify helper stamps still fail promotion
- [ ] 3.3 Leave #1333 fail-closed when the inventory-completeness guard fails or when scoring is standalone factory-gate without durable executed rows, and verify missing required coverage names that gap rather than a stable exclusion

## 4. Hard-gate text and release-eligibility regression

- [ ] 4.1 Keep `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` on `factory-release prepare` `frg_not_eligible`, and verify a unit test fails if the message equals only the bare `FRG structural eligibility failed for <version>. Hard gate: release preparation blocked.` sentence while those diagnostics are non-null
- [ ] 4.2 Keep HMAC attestation required on the tag/promote path, and verify prepare structural eligibility still uses `requireAttestation: false` without skipping later HMAC

## 5. Docs and CI

- [ ] 5.1 Update the FRG runbook unique-operation section so it names both host roots (loop state-home and control-repo generic `.agent-pipeline/runs`), the in-flight unbound-keep rule, and inventory-bound #1333 rows for in-flight ship, and verify those docs no longer imply state-home alone is the unique-operation source
- [ ] 5.2 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [ ] 5.3 Run `openspec validate ship-frg-unique-op-generic-run-store` and `npm run ci` from the repo root, and verify both exit 0
