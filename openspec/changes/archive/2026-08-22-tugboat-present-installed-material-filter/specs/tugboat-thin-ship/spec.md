## ADDED Requirements

### Requirement: Tugboat SHALL present an executable installed material-filter when it spawns stage-watch

Tugboat SHALL export `PIPELINE_MATERIAL_FILTER` (or equivalent PATH) to an executable installed `material-filter.mjs` when it spawns bundled `ship-stage-watch.sh --events-file`. The default resolved path SHALL be a pin/host skill install tree that `install.mjs` / `engine-promote` writes (`<skillDir>/scripts/material-filter.mjs`). The default SHALL NOT be the bare PATH name `material-filter.mjs`. The default SHALL NOT be `examples/supervisor/shell/` or repo `hosts/_shared/material-filter.mjs`. Live host supervisor env remaining unset SHALL NOT be required for that presentation. If the operator already set `PIPELINE_MATERIAL_FILTER` to a non-empty value, Tugboat SHALL NOT overwrite it. Existing `--events-file` argv, live-handoff binding, and sibling default `SHIP_STAGE_WATCH_BIN` SHALL remain in force.

#### Scenario: Watch spawn env presents the install-tree filter without host env

- **WHEN** Tugboat starts stage-watch for a train with `--events-file`
- **AND** `PIPELINE_MATERIAL_FILTER` is unset in host supervisor env
- **AND** an executable `material-filter.mjs` exists at `<skillDir>/scripts/material-filter.mjs` in a pin/host skill install tree
- **THEN** the watch spawn environment SHALL set `PIPELINE_MATERIAL_FILTER` to that executable path, or SHALL place that executable on the spawn PATH as `material-filter.mjs`
- **AND** the spawn PATH prefix of the sibling watch directory SHALL NOT be the sole filter location

#### Scenario: Operator-set PIPELINE_MATERIAL_FILTER is preserved

- **WHEN** the operator has already set `PIPELINE_MATERIAL_FILTER` to a non-empty value
- **AND** Tugboat starts stage-watch
- **THEN** Tugboat SHALL pass that value through to the watch spawn environment
- **AND** it SHALL NOT overwrite the operator-set value with an install-tree default

#### Scenario: Default is not the bare PATH name

- **WHEN** Tugboat resolves a default material filter because `PIPELINE_MATERIAL_FILTER` is unset
- **THEN** the default SHALL be an absolute executable under a skill install tree `scripts/material-filter.mjs`
- **AND** it SHALL NOT be the bare name `material-filter.mjs`

### Requirement: Tugboat SHALL NOT claim a live stage-watch pid when the material filter is missing

Tugboat SHALL log a named failure (`material filter missing` or equivalent) when no executable installed `material-filter.mjs` can be resolved for a stage-watch spawn (including an operator-set `PIPELINE_MATERIAL_FILTER` that is missing or not executable). Tugboat SHALL NOT log `stage-watch started pid=…` for that spawn. Tugboat SHALL NOT claim a live watch pid. Tugboat SHALL continue the train phase. Watch spawn failure SHALL NOT fail the ship.

#### Scenario: Missing filter is a named failure not a started pid

- **WHEN** Tugboat would spawn stage-watch with `--events-file`
- **AND** no executable `material-filter.mjs` is available via `PIPELINE_MATERIAL_FILTER` or spawn PATH
- **THEN** Tugboat SHALL log `material filter missing` (or equivalent)
- **AND** it SHALL NOT log `stage-watch started pid=` for that spawn
- **AND** it SHALL NOT claim a live watch pid
- **AND** it SHALL still run `pipeline train`

#### Scenario: Non-executable operator-set filter does not start a live watch

- **WHEN** `PIPELINE_MATERIAL_FILTER` is set to a path that is not an executable file
- **THEN** Tugboat SHALL NOT overwrite that value
- **AND** it SHALL log `material filter missing` (or equivalent)
- **AND** it SHALL NOT log `stage-watch started pid=` for that spawn

### Requirement: Tugboat stage-watch spawn env SHALL be regression-tested for an executable material-filter

Automated checks SHALL fail if Tugboat’s train-phase stage-watch spawn environment has neither `PIPELINE_MATERIAL_FILTER` pointing at an executable nor `material-filter.mjs` on the spawn PATH. A second check SHALL fail if the bundled `ship-stage-watch.sh` is spawned with only `--events-file` and no filter and the composer still logs `stage-watch started`. Those checks SHALL pass with live host supervisor env `PIPELINE_MATERIAL_FILTER` unset. Tests SHALL inspect Tugboat spawn env (and MAY extract helpers and inject a fake skill install tree). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails on the v1.39.10 spawn env with no filter

- **WHEN** the automated checks run against a Tugboat train watch spawn whose environment has neither `PIPELINE_MATERIAL_FILTER` pointing at an executable nor `material-filter.mjs` on the spawn PATH
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if started is logged without a filter

- **WHEN** the automated checks spawn bundled `ship-stage-watch.sh` with `--events-file` and no executable material filter in spawn env
- **AND** the composer logs `stage-watch started`
- **THEN** the checks SHALL fail

#### Scenario: Regression passes with an injected install-tree filter and host env unset

- **WHEN** the automated checks inject an executable `<skillDir>/scripts/material-filter.mjs`
- **AND** live host `PIPELINE_MATERIAL_FILTER` is unset
- **AND** Tugboat’s watch spawn env presents that executable via `PIPELINE_MATERIAL_FILTER` or spawn PATH
- **THEN** the checks SHALL pass
