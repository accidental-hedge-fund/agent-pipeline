## MODIFIED Requirements

### Requirement: Train completion and resume SHALL fail closed without re-failing complete trains

On a fresh train capture, Tugboat SHALL require the train-status complete helper to report complete with no blocker before leaving the train phase. When train exits non-zero because the milestone has no open issues, or a prior complete train artifact exists, Tugboat SHALL treat the train phase as already complete (resume) and SHALL NOT re-fail solely on a failed capture file that is not the success artifact.

When Tugboat treats train as already complete, Tugboat SHALL write a non-empty `train.complete.json` in that ship `RUN_DIR` before candidate composer re-exec. Tugboat SHALL NOT leave only a 0-byte `train.json` as the skip-train artifact. If `train.json` is already a non-empty success capture, Tugboat MAY copy it to `train.complete.json`. If `train.json` is empty or is an error capture, Tugboat SHALL write a non-empty complete artifact whose last `train_status` object has `complete` true and no blocker.

#### Scenario: Incomplete train_status blocks later phases

- **WHEN** train exits 0 but the train-status complete helper reports not complete
- **THEN** Tugboat SHALL fail the train phase
- **AND** it SHALL NOT proceed to the FRG pack phase or release prepare

#### Scenario: Resume accepts prior complete artifact

- **WHEN** train exits non-zero
- **AND** a prior complete train artifact is present and the complete helper reports complete
- **THEN** Tugboat SHALL treat train as resumed/ok
- **AND** it SHALL proceed to later ship phases

#### Scenario: Empty-milestone resume writes a non-empty complete artifact

- **WHEN** train exits non-zero because the milestone has no open issues
- **AND** `train.json` is empty (0 bytes)
- **AND** `train.complete.json` is absent
- **THEN** Tugboat SHALL write a non-empty `train.complete.json`
- **AND** that artifact's last `train_status` SHALL have `complete` true and no blocker
- **AND** Tugboat SHALL treat train as resumed/ok
- **AND** it SHALL proceed to later ship phases including candidate composer re-exec

### Requirement: Tugboat SHALL re-exec candidate tugboat.sh after train-complete

After train is complete or resumed complete and the candidate engine root is resolved, Tugboat SHALL exec `$SHIP_END_ENGINE_ROOT/examples/supervisor/shell/tugboat.sh` for FRG pack onward when the running script is not already that file. The re-exec SHALL set `TUGBOAT_SKIP_TRAIN=1` so train does not run again. Process-start `tugboat.sh` from a stale checkout SHALL NOT compose FRG pack, release, ensure-tag, or promote after that re-exec.

When `TUGBOAT_SKIP_TRAIN` is set, Tugboat SHALL skip `pipeline train` and continue when any of the following is true:

1. a non-empty `train.complete.json` exists in `RUN_DIR`, or
2. a non-empty `train.json` exists in `RUN_DIR`, or
3. `RUN_DIR` `state.json` or `train.stderr` records that train already resumed because the milestone has no open issues.

Tugboat SHALL fail closed only when none of those skip-train proofs exist. Tugboat SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact` on the empty-milestone resume path. Tugboat SHALL NOT require a human fast-forward of `REPO_DIR` for that path.

#### Scenario: Stale process-start tugboat does not compose FRG after train

- **WHEN** train merges a composer fix onto main at SHA `C`
- **AND** process-start `tugboat.sh` is an older tree
- **AND** the candidate engine root at `C` contains `examples/supervisor/shell/tugboat.sh`
- **THEN** Tugboat SHALL exec that candidate `tugboat.sh` before FRG pack
- **AND** the process-start script SHALL NOT invoke `factory-release prepare` after that exec

#### Scenario: Re-exec does not re-run train

- **WHEN** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **AND** `train.complete.json` exists for that milestone
- **THEN** the candidate composer SHALL skip `pipeline train`
- **AND** it SHALL continue at candidate-engine resolution and FRG pack

#### Scenario: Skip-train accepts a non-empty complete artifact

- **WHEN** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **AND** `train.complete.json` is non-empty
- **THEN** the candidate composer SHALL skip `pipeline train`
- **AND** it SHALL continue at candidate-engine resolution and FRG pack
- **AND** it SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`

#### Scenario: Skip-train accepts empty-milestone resume evidence without a complete file

- **WHEN** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **AND** `train.json` is 0 bytes
- **AND** `train.complete.json` is absent
- **AND** `train.stderr` or `state.json` records that train resumed because the milestone has no open issues
- **THEN** the candidate composer SHALL skip `pipeline train`
- **AND** it SHALL continue at candidate-engine resolution and FRG pack
- **AND** it SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`
- **AND** it SHALL NOT require a human fast-forward of `REPO_DIR`

## ADDED Requirements

### Requirement: Tugboat MAY porcelain-clean fast-forward REPO_DIR to origin base

When `REPO_DIR` porcelain is empty, Tugboat MAY `git fetch` and fast-forward `REPO_DIR` to `origin/<base>` so process-start Tugboat matches the candidate. `<base>` SHALL be the same integration branch Tugboat already uses for the factory-release request (`TUGBOAT_BASE_BRANCH` when set, else `.github/pipeline.yml` `base_branch`). When porcelain is not empty, Tugboat SHALL NOT force-ff. A skipped or failed optional fast-forward SHALL NOT fail the ship. Tugboat SHALL NOT require a human `git merge --ff-only` as the product path.

#### Scenario: Clean checkout may fast-forward to origin base

- **WHEN** `REPO_DIR` `git status --porcelain` is empty
- **AND** `origin/<base>` is ahead of local `HEAD`
- **THEN** Tugboat MAY fetch and fast-forward `REPO_DIR` to `origin/<base>`
- **AND** it SHALL NOT fail the ship if it skips that fast-forward

#### Scenario: Dirty checkout is not force fast-forwarded

- **WHEN** `REPO_DIR` porcelain is not empty
- **THEN** Tugboat SHALL NOT run `git merge --ff-only` (or equivalent force-ff) on `REPO_DIR`
- **AND** it SHALL continue the ship without that fast-forward

### Requirement: Tugboat EXIT and RETURN lock release SHALL NOT dereference unbound lock_dir

Tugboat `ship_one` EXIT and RETURN lock-release traps SHALL NOT print `lock_dir: unbound variable` under `set -u`. Tugboat SHALL bind `lock_dir` before those traps run, or the release function SHALL no-op when `lock_dir` is unset. A successful ship SHALL still release the ship lock when `lock_dir` is bound.

#### Scenario: Successful ship EXIT does not print unbound lock_dir

- **WHEN** `ship_one` completes with phase status `ok`
- **AND** the EXIT trap runs under `set -u`
- **THEN** Tugboat SHALL NOT print `lock_dir: unbound variable`
- **AND** it SHALL NOT fail the ship solely because that trap ran

#### Scenario: Bound lock_dir is still released

- **WHEN** `ship_one` holds `RUN_DIR/lock` and `lock_dir` is bound
- **AND** the RETURN or EXIT trap runs
- **THEN** Tugboat SHALL release that lock directory

### Requirement: Empty-milestone skip-train and lock-release traps SHALL be regression-tested

Automated checks SHALL extract the real Tugboat helpers that write the train-complete artifact, decide skip-train, and release the ship lock from `examples/supervisor/shell/tugboat.sh`. Those checks SHALL fail on the v1.39.7 bodies:

- no-open-issues resume with empty `train.json` and missing `train.complete.json` does not write a non-empty complete artifact, then skip-train fails
- EXIT/RETURN lock release prints `lock_dir: unbound variable` under `set -u` after a successful ship

After the fix, the same extracted helpers SHALL write and accept a non-empty complete artifact, SHALL accept empty-milestone RUN_DIR resume evidence, and SHALL NOT print the unbound-variable error. Tests SHALL inject fixtures and SHALL NOT start a live train, network call, git, or subprocess ship.

#### Scenario: Regression fails if empty-milestone resume leaves no skip-train artifact

- **WHEN** the automated checks run the 1.39.7 resume helper with `train.json` of 0 bytes and no `train.complete.json`
- **AND** train stderr contains `has no open issues`
- **THEN** the checks SHALL fail if skip-train then fails for missing train artifact
- **AND** the checks SHALL fail if `train.complete.json` is still absent or 0 bytes

#### Scenario: Regression fails if EXIT trap prints unbound lock_dir

- **WHEN** the automated lock-release probe runs the 1.39.7 EXIT trap under `set -u` after `ship_one` locals are gone
- **THEN** the checks SHALL fail if stderr contains `lock_dir: unbound variable`

#### Scenario: Fixed helpers write and accept a complete artifact

- **WHEN** the automated checks run the fixed resume and skip-train helpers on the empty-milestone fixture
- **THEN** `train.complete.json` SHALL be non-empty
- **AND** skip-train SHALL accept that artifact (or RUN_DIR no-open-issues evidence)
- **AND** it SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`
