## Why

`pipeline ship --milestone v1.40.1` cannot prepare a release. After a complete integrate train and a finished factory-gate pack, `factory-release prepare` fails structural eligibility solely because unique-operation SLOs score the **candidate worktree** run-store (empty) instead of control-host durable train/loop/merge/handoff evidence, and because required entrypoint `ship` cannot be a completed unique-operation of the same in-flight ship whose FRG pack is being scored. This is a class deadlock in the shared release-eligibility validator, not a v1.40.1 mole.

## What Changes

- Ship FRG unique-operation scoring SHALL collect durable run, event, loop-store, and handoff attempts from the **control-host** store bound to the scored candidate. It SHALL NOT treat an empty candidate-worktree `.agent-pipeline/runs` as proof that train, loop, or merge never ran.
- Required entrypoint `ship` SHALL NOT deadlock the in-flight ship's FRG pack. Absence of a completed unique-operation for **this** ship SHALL NOT increment missing required coverage. A completed **prior** ship remains valid coverage.
- Missing #1301 live `train_loop_linked` SHALL be scored from the control-host train stream for the scored candidate, not from the factory-gate pack loop alone.
- Ship FRG scoring SHALL pass candidate-bound #1333 executed matrix rows through the existing aggregator seam. Undefined executed-row input SHALL NOT silently score as zero coverage when durable candidate-bound rows exist. Helper stamps and pack-issue labels SHALL NOT substitute.
- `factory-release prepare` structural-eligibility hard-gate text SHALL include the `uniqueOperationSloFailure` / `uniqueOperationReleaseBindingFailure` string. It SHALL NOT stay a generic "FRG structural eligibility failed" line when unique-operation SLOs are the defect.
- Factory-gate 2-item pack proofs (clean-docs + clean-openspec + hybrid v2 Layer A) SHALL remain necessary and SHALL NOT be unique-operation proof. Unique-operation coverage SHALL remain fail-closed when durable evidence is actually missing.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `factory-reliability-gate`: ship FRG unique-operation scoring uses control-host durable evidence bound to the scored candidate; in-flight `ship` is not a missing-coverage fail; #1301 live train-link is scored from the control-host train stream; structural eligibility failure names unique-operation SLO/binding text; pack proofs are not unique-operation substitutes.
- `operation-reliability`: required public entrypoint `ship` does not increment missing required coverage for the in-flight ship's own FRG pack; empty candidate-worktree stores do not prove missing entrypoints when a bound control-host store exists; fail-closed when that host store is empty.

## Impact

- **Class vs site:** class is unique-operation scoring for release-eligible FRG. The scorer reads the wrong store root and treats the in-flight `ship` as missing coverage. Shared surfaces: `collectUniqueOperationsFromRunStore` / `runFactoryGate` evidence root, `aggregateUniqueOperationReliability` required-entrypoint coverage, `isReleaseEligibleFrgPass`, and `factory-release prepare` hard-gate text. The next identical empty-worktree / in-flight-ship fault uses this same scoring law. It does not need a new mole issue.
- **Reuse first:** keep `collectUniqueOperationsFromRunStore`, `filterAttemptsBoundToCandidate`, `attemptsFromRunArtifacts`, `uniqueOperationSloFailure`, `uniqueOperationReleaseBindingFailure`, `bindExecutedMatrixRowsForCandidate`, and `isReleaseEligibleFrgPass`. Point collection at the same control-host state-home / run-store root factory-release already uses for pack-loop artifacts (`resolveStateHome`). Do not add a second aggregator, FRG runner, scheduler, or unique-operation CLI.
- **CLI:** no new public verb. No merge-authority change. HMAC attestation on tag/promote stays required.
- **Tests:** hermetic unit tests inject run-store/fs seams. No live network, git, or subprocess.
- **Docs:** FRG runbook and CLI docs must name the control-host evidence root and the in-flight-ship coverage rule.
- **Sequencing:** consumes unique-operation SLOs (#1368), live train-loop linkage (#1301), executed #1333 matrix rows, and hybrid v2 pack proofs. Does not weaken those gates when evidence is absent.

## Acceptance Criteria

- [ ] A ship whose integrate train already completed on the control host, with durable train/loop/merge events bound to the scored candidate, SHALL NOT fail FRG structural eligibility solely because the candidate worktree `.agent-pipeline/runs` is empty.
- [ ] Required entrypoint `ship` SHALL NOT deadlock FRG pack of the in-flight ship (in-flight ship is not a missing-coverage fail for that pack; a completed prior ship remains valid coverage).
- [ ] Missing #1301 live `train_loop_linked` is scored from the control-host train stream when that stream exists for the candidate, not from the factory-gate pack loop alone.
- [ ] `factory-release prepare` hard-gate text SHALL include the unique-operation SLO/binding failure string.
- [ ] A regression fails if `isReleaseEligibleFrgPass` is false when hybrid v2 pack proofs pass and unique-ops are supplied from a host run-store with train+merge coverage and no completed `ship` attempt for this ship.
- [ ] A regression still fails if unique-ops are truly absent (empty host store, no train events).
- [ ] Tests inject run-store/fs seams; no live network, git, or subprocess.
- [ ] After `core/` edits, `node scripts/build.mjs` and `npm run ci` pass.
- [ ] Pack-issue `pipeline:ready-to-deploy` labels SHALL NOT become unique-operation proof.
- [ ] HMAC attestation on the tag/promote path SHALL remain required.
