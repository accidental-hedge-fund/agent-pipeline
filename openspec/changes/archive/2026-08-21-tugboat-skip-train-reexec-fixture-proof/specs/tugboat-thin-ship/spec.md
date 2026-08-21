## MODIFIED Requirements

### Requirement: Tugboat SHALL re-exec candidate tugboat.sh after train-complete

After train is complete or resumed complete and the candidate engine root is resolved, Tugboat SHALL exec `$SHIP_END_ENGINE_ROOT/examples/supervisor/shell/tugboat.sh` for FRG pack onward when the running script is not already that file. The re-exec SHALL set `TUGBOAT_SKIP_TRAIN=1` so train does not run again. Process-start `tugboat.sh` from a stale checkout SHALL NOT compose FRG pack, release, ensure-tag, or promote after that re-exec.

When `TUGBOAT_SKIP_TRAIN` is set, Tugboat SHALL skip `pipeline train` and continue when any of the following is true:

1. a non-empty `train.complete.json` exists in `RUN_DIR`, or
2. a non-empty `train.json` exists in `RUN_DIR`, or
3. `RUN_DIR` `state.json` or `train.stderr` records that train already resumed because the milestone has no open issues.

Tugboat SHALL fail closed only when none of those skip-train proofs exist. Tugboat SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact` on the empty-milestone resume path. Tugboat SHALL NOT require a human fast-forward of `REPO_DIR` for that path.

Before that `exec`, Tugboat SHALL export `PIPELINE_SUPERVISOR_STATE` (the same state root used to compute that ship `RUN_DIR`) and `REPO_DIR` so the candidate process reads the same ship artifacts. Tugboat SHALL NOT re-exec into a different state root when those values were already resolved for the process-start ship.

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

#### Scenario: Re-exec exports supervisor state and repo dir

- **WHEN** Tugboat execs candidate `tugboat.sh` after train-complete
- **AND** process-start `PIPELINE_SUPERVISOR_STATE` is `/state` and `REPO_DIR` is `/control`
- **THEN** the candidate process environment SHALL contain `PIPELINE_SUPERVISOR_STATE` set to `/state`
- **AND** it SHALL contain `REPO_DIR` set to `/control`
- **AND** skip-train SHALL read proof from `/state/ship-vX.Y.Z/` for that milestone
- **AND** it SHALL NOT recompute state under `$HOME/.local/state/pipeline-supervisor` when `/state` was already resolved

## ADDED Requirements

### Requirement: Spawn-real-tugboat skip-train re-exec fixtures SHALL leave proof and isolate parent skip-train env

Spawn-real-tugboat skip-train re-exec fixtures SHALL leave a skip-train proof in that ship `RUN_DIR` before the re-exec. Those fixtures spawn real `examples/supervisor/shell/tugboat.sh` and then re-exec the candidate composer with `TUGBOAT_SKIP_TRAIN=1`. Proof SHALL be a non-empty `train.complete.json`, or a non-empty `train.json`, or documented empty-milestone stderr / state as already accepted by skip-train. The shared FRG fixture writer and the candidate-engine spawn tests (#1151) SHALL do this.

Those fixtures SHALL NOT inherit parent `TUGBOAT_SKIP_TRAIN=1` or `TUGBOAT_CANDIDATE_COMPOSER` from the process environment unless the check is itself asserting skip-train. The first spawned process SHALL still run train (or fail closed for the original candidate / FRG reason). The checks SHALL still assert original FRG pack and candidate-engine behavior. They SHALL NOT be reduced to skip-train-only assertions.

The four v1.39.8 release-CI failures SHALL fail on current `main` without that isolation and proof when parent skip-train env is present, and SHALL pass with isolation and proof:

1. after train-complete, candidate argv records `factory-release` and pin argv records `train`
2. live `in_progress` at cap 1 keeps ticking prepare
3. not-live `in_progress` at cap 1 fails closed
4. unavailable candidate engine fails closed before pin `factory-release`

Tests SHALL inject fixtures and a fake pipeline. They SHALL NOT start a live train, network pack, git tag, or subprocess ship.

#### Scenario: Shared FRG fixture leaves skip-train proof before re-exec

- **WHEN** the shared FRG fixture spawns real `tugboat.sh`
- **AND** train is treated complete
- **AND** Tugboat re-execs candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`
- **THEN** that ship `RUN_DIR` SHALL contain a skip-train proof before the re-exec
- **AND** the candidate composer SHALL NOT fail `TUGBOAT_SKIP_TRAIN without a prior train artifact`

#### Scenario: Parent skip-train env does not skip the fixture's own train

- **WHEN** the process environment has `TUGBOAT_SKIP_TRAIN=1` (a live Tugboat `pipeline release` child)
- **AND** a spawn-real-`tugboat.sh` fixture is not itself asserting skip-train
- **THEN** the spawned first process SHALL NOT inherit that skip-train flag
- **AND** it SHALL still invoke pin `train` (or fail closed for the original candidate / FRG reason)
- **AND** it SHALL NOT fail skip-train before those original assertions

#### Scenario: Four named tests keep original FRG and candidate assertions

- **WHEN** the four named #1150 / #1151 spawn-real-`tugboat.sh` tests run with isolation and proof
- **THEN** they SHALL still record candidate `factory-release` vs pin `train`, live-wait prepare ticks, not-live pack-fail, and unavailable-engine fail-closed
- **AND** they SHALL NOT pass solely because skip-train succeeded

#### Scenario: Regression fails on main without isolation and proof under parent skip-train env

- **WHEN** parent skip-train env is present as in v1.39.8 release CI
- **AND** the four named tests run against current `main` without isolation and without skip-train proof in `RUN_DIR`
- **THEN** those tests SHALL fail
- **AND** the failure text SHALL include `TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`
