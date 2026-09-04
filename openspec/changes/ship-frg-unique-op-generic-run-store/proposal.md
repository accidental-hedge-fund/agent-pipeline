## Why

`pipeline ship --milestone v1.40.1` still fails Factory Reliability Gate (FRG) structural eligibility after #1428. Unique-operation collection reads the loop state-home runs root (`resolveStateHome()/runs`) and then drops the control-host generic train/advance/merge artifacts because they have no `candidate_sha`, no `logical_operation_id`, and no mapped public entrypoint. The live host has those artifacts at `<control-repo>/.agent-pipeline/runs`. Scoring them as empty is a class collector defect, not a v1.40.1 mole.

## What Changes

- Factory-release and factory-gate unique-operation collection SHALL read the control-host generic run store used for train/advance/merge (`<control-repo>/.agent-pipeline/runs`) **in addition to** the loop state-home runs root. An empty candidate-worktree `.agent-pipeline/runs` directory SHALL NOT prove that those operations never ran.
- In-flight ship scoring SHALL keep unbound control-host attempts that lack `candidate_sha` (and, when absent, release identity). Standalone factory-gate SHALL still drop unbound attempts. Other-candidate SHAs SHALL still drop.
- `attemptsFromRunArtifacts` SHALL map a recognized public entrypoint from `run.json.kind`, `run_start.entrypoint`, or a stable run-id prefix (`train-`, `loop-`, `merge-`, numeric drive). When the artifact has no `logical_operation_id`, it SHALL use `run_id` as the aggregation identity so those attempts can observe entrypoints. That fallback SHALL NOT count as verified unique-operation success.
- In-flight ship scoring SHALL attach #1333 `executed_matrix_rows` bound to the scored candidate SHA from the candidate tree's `FAULT_RECOVERY_MATRIX` when `assertFaultRecoveryInventoryComplete` passes for that tree. It SHALL NOT stamp `passingUniqueOperationManifest().covered_lifecycle_classes`.
- Hard-gate text SHALL keep `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` on `frg_not_eligible`. It SHALL NOT emit the bare fallback sentence when those diagnostics exist.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `operation-reliability`: unique-operation collection for release-eligible FRG reads the control-host generic run store plus the loop state-home; in-flight ship keeps unbound host attempts and maps entrypoints/identity from durable artifacts; standalone factory-gate still drops unbound attempts.
- `factory-reliability-gate`: ship/factory-gate unique-operation scoring uses both host stores; in-flight ship attaches candidate-bound #1333 executed rows from a complete matrix inventory through the existing binder; prepare `frg_not_eligible` hard-gate text keeps unique-operation SLO/binding diagnostics.
- `universal-fault-recovery-matrix`: a complete candidate-tree inventory MAY feed in-flight ship #1333 coverage as executed rows bound to the scored SHA through the existing binder. Incomplete inventory SHALL NOT. Helper class stamps SHALL NOT.

## Impact

- **Class vs site:** class is unique-operation evidence collection for release-eligible FRG. #1428 pointed the scorer at the loop state-home and kept fail-closed SHA binding. Control-host train/advance/merge live in the generic run store and historically omit `candidate_sha` / `logical_operation_id`. Shared surfaces: `uniqueOperationRunsRoots` / `collectUniqueOperationsFromRunStore`, `filterAttemptsBoundToCandidate`, `attemptsFromRunArtifacts`, `defaultScoreBoundPackLoop`, `bindExecutedMatrixRowsForCandidate` / `assertFaultRecoveryInventoryComplete`, and prepare hard-gate text. The next identical empty-generic-store / unbound-host-artifact / missing-inventory-row fault uses this same law. It does not need a new mole issue.
- **Reuse first:** keep the collector, binder, SLO functions, inventory guard, and `isReleaseEligibleFrgPass`. Add the generic run-store root next to the loop state-home. Reuse `runsDir` / factory-control root resolution for the generic path. Do not add a second aggregator, FRG runner, scheduler, unique-operation CLI, or executed-row store format.
- **CLI:** no new public verb. No merge-authority change. HMAC attestation on tag/promote stays required. `ship` stays in `REQUIRED_PUBLIC_ENTRYPOINTS`.
- **Tests:** hermetic unit tests inject host run stores. No live network, git, or subprocess.
- **Docs:** FRG runbook unique-operation section must name both host roots (loop state-home and control-repo generic `.agent-pipeline/runs`) and the in-flight unbound-keep rule.
- **Out of scope:** merging factory-gate pack PRs from recover paths; dropping `ship` from required public entrypoints; weakening unique-operation SLOs when both host stores are actually empty.

## Acceptance Criteria

- [ ] Unique-operation collection for factory-release / factory-gate reads `<control-repo>/.agent-pipeline/runs` and the loop state-home runs root. An empty candidate-worktree `.agent-pipeline/runs` plus populated control-host generic runs observes required public entrypoints under `inFlightShip`.
- [ ] In-flight ship scoring keeps unbound train/loop (and other recognized public-entrypoint) artifacts that lack `candidate_sha`. Standalone factory-gate drops those same unbound artifacts.
- [ ] `attemptsFromRunArtifacts` maps `drive` / `single` / `loop` / `train` / `merge` / `merge-queue` / `ship` from `run.json.kind`, `run_start.entrypoint`, or a stable run-id prefix (`train-`, `loop-`, `merge-`, numeric drive). Artifacts with no `logical_operation_id` use `run_id` as aggregation identity. That identity does not count as verified unique-operation success.
- [ ] In-flight ship scoring covers all five #1333 lifecycle classes from candidate-tree `FAULT_RECOVERY_MATRIX` rows bound to the request candidate SHA when `assertFaultRecoveryInventoryComplete` passes. `passingUniqueOperationManifest().covered_lifecycle_classes` does not populate that coverage.
- [ ] When `factory-release prepare` returns `defect_class: "frg_not_eligible"` and unique-operation SLO or binding diagnostics exist, the hard-gate message includes `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` text. It is not only the bare "FRG structural eligibility failed … Hard gate: release preparation blocked." sentence.
- [ ] An empty control-host generic store **and** empty loop state-home still fail closed as missing required coverage. Pack-issue `pipeline:ready-to-deploy` labels are not unique-operation proof.
- [ ] Tests inject host run stores (no network, git, or subprocess). After `core/` edits, `node scripts/build.mjs` and `npm run ci` pass.
