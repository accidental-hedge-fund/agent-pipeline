## 1. Dual-root unique-operation collection

- [x] 1.1 Add injectable `resolveUniqueOperationRunsRoots` on `FactoryGateOpts` whose production default returns canonicalized loop state-home `<resolveStateHome({ env })>/runs` plus generic `runsDir(resolveFactoryControlRoot(...))` when that root is non-null, and verify a hermetic test with empty candidate-worktree runs plus populated generic-host runs observes required public entrypoints under `opts.inFlightShip === true`
- [x] 1.2 Do not derive the generic root from `runsDir(opts.repoDir)` unless that resolved path already equals one of the two allowed roots, and verify candidate-worktree-only artifacts still fail when both host roots are empty
- [x] 1.3 Pass the canonicalized pair as `approvedRoots` to `loadFollowableChildRun`, and verify a `train_loop_linked` events path that resolves in the candidate worktree is not loaded
- [x] 1.4 Deduplicate by run id across the two roots (state-home first, then generic; first occurrence wins), and verify the same durable `run_id` present in both roots is scored once
- [x] 1.5 Wire `defaultScoreBoundPackLoop` and CLI `pipeline factory-gate` (`core/scripts/pipeline.ts` `runFactoryGate` call) through the same resolver without a new CLI verb, and verify an in-process score with `inFlightShip: true` and no explicit `uniqueOperationRunsRoot` still reads an injected control-host generic store
- [x] 1.6 Keep fail-closed behavior when the generic store **and** the loop state-home are both empty, and verify `missing_required_coverage > 0` and `isReleaseEligibleFrgPass` is false even if pack-issue labels say ready-to-deploy

## 2. In-flight unbound keep and attempt mapping

- [x] 2.1 Gate in-flight collector exceptions only on `opts.inFlightShip === true` (set by `defaultScoreBoundPackLoop`; not inferred from `factory_release_binding`), and verify standalone `runFactoryGate` without that flag keeps strict binding
- [x] 2.2 Extend `filterAttemptsBoundToCandidate` so in-flight ship keeps attempts that lack `candidate_sha` and lack release identity, and verify unbound train/loop artifacts are kept for `inFlightShip: true` and dropped for standalone factory-gate
- [x] 2.3 Keep dropping other-candidate SHAs and present mismatched release identities during in-flight ship, and verify those artifacts still cannot satisfy the scored candidate
- [x] 2.4 Extend `attemptsFromRunArtifacts` with precedence: recognized `run_start.entrypoint`, then recognized `run.json.kind`, then prefixes (`merge-queue-`/`mq-` before remaining `merge-`; `train-`; `loop-`; numeric drive). Verify: start-event wins over kind; kind wins over prefix; `kind: "advance"` is not coerced to `single` and falls through to prefix; `mq-1` maps `merge-queue`; `merge-1` maps `merge`
- [x] 2.5 Use `run_id` as aggregation identity with `identity_provenance: "run_id_fallback"` when the artifact has no `logical_operation_id`, and verify that fallback does not count as verified unique-operation success
- [x] 2.6 Treat in-flight kept fallback-identity host artifacts as entrypoint coverage observation so they do not increment `missing_correlation` or `ownerless_terminal` solely for a missing minted id / missing postcondition proof, and verify a regression fails if those counts rise for prefix-only unbound train/loop artifacts under `inFlightShip`
- [x] 2.7 Stamp kept missing-field in-flight attempts as `unbound_inflight` and exclude them from clean-completion success, stable exclusions, and ownerless-terminal numerators even when they carry a minted logical id and verified completion; verify a regression with that shape

## 3. In-flight #1333 inventory rows

- [x] 3.1 Add injectable `loadCandidateFaultRecoveryInventory` that returns `{ rows, sourceSha }`. When `opts.inFlightShip === true`, host artifacts have no binder-accepted rows for the scored SHA, `sourceSha` equals that SHA, and `assertFaultRecoveryInventoryComplete(rows)` passes, map applicable cells to `executed_matrix_rows` bound to the scored SHA and pass them through `bindExecutedMatrixRowsForCandidate`. Verify all five #1333 lifecycle classes become covered
- [x] 3.2 Do not attach inventory when `sourceSha` is missing or differs from the scored SHA, and verify a host-checkout inventory at another SHA does not populate coverage
- [x] 3.3 Do not stamp `passingUniqueOperationManifest().covered_lifecycle_classes`, and verify helper stamps still fail promotion
- [x] 3.4 Leave #1333 fail-closed when the inventory-completeness guard fails, and verify that case separately from the complete-inventory case
- [x] 3.5 Leave #1333 fail-closed for standalone factory-gate without durable executed rows, and verify scoring does not mint inventory rows when `opts.inFlightShip` is not true
- [x] 3.6 Load candidate inventory from a commit-bound data blob (`git show <candidateSha>:<inventory.json>`) with a non-executing parser; do not dynamically import candidate-tree TypeScript. Verify dirty-worktree and hostile-top-level-code regressions

## 4. Hard-gate text and release-eligibility regression

- [x] 4.1 Keep `uniqueOperationSloFailure` on `factory-release prepare` `frg_not_eligible`, and verify a unit test includes that string when it is the only unique-operation diagnostic
- [x] 4.2 Keep `uniqueOperationReleaseBindingFailure` on the same path, and verify a unit test includes that string when it is the only unique-operation diagnostic
- [x] 4.3 When both diagnostics exist and differ, include both strings, and verify the message is not only `factory-release prepare: FRG structural eligibility failed for <version>. Hard gate: release preparation blocked.`
- [x] 4.4 Keep the CLI fallback (`generated.message ?? "FRG structural eligibility failed for <ver>"`) from emitting that bare sentence when those diagnostics exist
- [x] 4.5 Keep HMAC attestation required on the tag/promote path, and verify prepare structural eligibility still uses `requireAttestation: false` without skipping later HMAC

## 5. Docs and CI

- [x] 5.1 Update `docs/factory-reliability-gate-runbook.md` section "Unique-operation reliability (#1368 / #1428)" so it names both host roots (loop state-home `<resolveStateHome()>/runs` and control-repo generic `.agent-pipeline/runs`), the injectable dual-root resolver, the in-flight missing-field keep rule, child-handoff confinement to those roots, and inventory-bound #1333 rows for in-flight ship when `sourceSha` matches. Verify those docs no longer imply state-home alone is the unique-operation source
- [x] 5.2 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [x] 5.3 Run `openspec validate ship-frg-unique-op-generic-run-store` and `npm run ci` from the repo root, and verify both exit 0
