## ADDED Requirements

### Requirement: Tugboat ship-end CLI SHALL spawn Node major 24 or newer

Tugboat SHALL resolve the Node binary for `SHIP_END_CLI` to a binary whose `process.versions.node` major version is greater than or equal to 24. When `SHIP_END_NODE` is unset, or when it resolves to a major version below 24, Tugboat SHALL walk `PATH` for `node`, then try `/usr/bin/node` and `/usr/local/bin/node`, and SHALL use the first binary that meets the major-24 floor. Tugboat SHALL log the resolved path. Tugboat SHALL fail closed when no such binary exists. A systemd or host export of `SHIP_END_NODE` SHALL NOT be required for a passing ship.

#### Scenario: PATH node 22 yields /usr/bin/node 24

- **WHEN** `SHIP_END_NODE` is unset
- **AND** `PATH` `node` reports version `22.23.2`
- **AND** `/usr/bin/node` reports version `24.18.0`
- **THEN** Tugboat SHALL spawn `SHIP_END_CLI` with `/usr/bin/node`
- **AND** it SHALL NOT spawn the version-22 binary
- **AND** it SHALL log the resolved Node path

#### Scenario: PATH walk finds Node 24 after a failing default

- **WHEN** `SHIP_END_NODE` is `node` and that binary is major 22
- **AND** a later `PATH` directory contains a `node` binary whose major version is 24
- **THEN** Tugboat SHALL spawn `SHIP_END_CLI` with that major-24 binary

### Requirement: Tugboat ensure-tag SHALL pass repo-path to the candidate CLI

Tugboat `invoke_release_ensure_tag` SHALL invoke candidate `release ensure-tag` with `--repo-path "$REPO_DIR"` in addition to the version, merge-commit OID, and `--packed-candidate`. Tugboat SHALL fail closed when `REPO_DIR` is empty. Tugboat SHALL NOT omit repository identity so that `cfg.repo` empty cannot block observe.

#### Scenario: ensure-tag argv includes --repo-path

- **WHEN** Tugboat runs ensure-tag after release finish
- **AND** `REPO_DIR` is `/control`
- **THEN** the candidate argv SHALL include `--repo-path` and `/control`

### Requirement: Tugboat SHALL re-exec candidate tugboat.sh after train-complete

After train is complete or resumed complete and the candidate engine root is resolved, Tugboat SHALL exec `$SHIP_END_ENGINE_ROOT/examples/supervisor/shell/tugboat.sh` for FRG pack onward when the running script is not already that file. The re-exec SHALL set `TUGBOAT_SKIP_TRAIN=1` so train does not run again. Process-start `tugboat.sh` from a stale checkout SHALL NOT compose FRG pack, release, ensure-tag, or promote after that re-exec. When `TUGBOAT_SKIP_TRAIN` is set, Tugboat SHALL require a prior train complete artifact and SHALL fail closed without it.

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
