## MODIFIED Requirements

### Requirement: Tugboat SHALL resolve the candidate engine after train-complete

After train is complete or resumed complete, Tugboat SHALL resolve and prepare the candidate engine as the control checkout at the FRG-bound `integrated_candidate.git_sha` (40-hex from the factory-release request JSON), or as an explicit candidate install of that SHA, before the FRG pack phase. Allowed roots are a clean `REPO_DIR` whose `HEAD` equals that SHA, `$REPO_DIR/.worktrees/ship-candidate-<sha>`, or `PIPELINE_CANDIDATE_ENGINE_ROOT` after the same `HEAD` and porcelain checks. Tugboat SHALL obtain that root from the shared resolve-and-prepare seam before candidate CLI spawn. Identity-only resolution SHALL NOT authorize spawn. The entrypoint SHALL be `node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs"` with cwd `REPO_DIR`. Tugboat SHALL invoke subsequent `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and `release ensure-tag` through that prepared candidate. If resolution or candidate readiness fails, or the resolved `commit_sha` does not equal the SHA being released, Tugboat SHALL fail closed and SHALL NOT fall back to the process-start `$PIPELINE` production pin for those verbs. Train checkpoint SHALL remain so a retry does not retrain. Tugboat SHALL NOT reimplement candidate install in shell as a second bootstrap path.

Tugboat MAY keep process-start `$PIPELINE` for train and `engine-promote`. Tugboat SHALL NOT retarget train to the unpromoted candidate.

#### Scenario: Candidate checkout at the FRG-bound SHA is used for release

- **WHEN** train completes and the FRG-bound candidate SHA is `C`
- **AND** a control checkout or candidate install of `C` is resolvable
- **THEN** Tugboat SHALL invoke `pipeline release` through that candidate
- **AND** that invocation's engine `commit_sha` SHALL equal `C`

#### Scenario: Missing candidate engine fails before FRG pack

- **WHEN** train is complete
- **AND** no control checkout or candidate install matches the FRG-bound SHA
- **THEN** Tugboat SHALL fail before `factory-release prepare`
- **AND** it SHALL NOT invoke prepare via the previous production-pin `$PIPELINE`

#### Scenario: Unready candidate fails before FRG pack

- **WHEN** train is complete
- **AND** a control checkout or candidate install matches the FRG-bound SHA
- **AND** resolve-and-prepare cannot prove candidate readiness
- **THEN** Tugboat SHALL fail before `factory-release prepare`
- **AND** it SHALL NOT invoke prepare via the previous production-pin `$PIPELINE`
- **AND** it SHALL NOT spawn candidate CLI before readiness succeeds
