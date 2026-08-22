## ADDED Requirements

### Requirement: Ship progress adapters SHALL present an executable installed material-filter without requiring host env

A channel adapter that applies the shared material filter to `pipeline ship` progress SHALL receive an executable installed `material-filter.mjs` in spawn environment from the pin/host skill install tree (`<skillDir>/scripts/material-filter.mjs` as written by `install.mjs` / `engine-promote`). Host supervisor env remaining unset SHALL NOT be required for that spawn to exec the filter. `engine-promote` SHALL NOT be required to write supervisor env for this spawn to work. An operator-set `PIPELINE_MATERIAL_FILTER` SHALL remain an override and SHALL NOT be overwritten by the adapter. Exact-run `--events-file` identity and observational notify SHALL remain in force.

#### Scenario: Installed filter is presented when supervisor env is unset

- **WHEN** a ship progress adapter spawns bundled `ship-stage-watch.sh --events-file` for a live ship run
- **AND** host supervisor env does not set `PIPELINE_MATERIAL_FILTER`
- **AND** `install.mjs` / `engine-promote` has written an executable `<skillDir>/scripts/material-filter.mjs`
- **THEN** the spawn environment SHALL present that executable to the watch
- **AND** the watch SHALL NOT depend on a leftover PATH name `material-filter.mjs`

#### Scenario: Promote does not have to write supervisor env

- **WHEN** `engine-promote --host all` updates host skill trees and does not write `~/.config/pipeline-supervisor/env`
- **THEN** the next ship progress watch spawn SHALL still present the installed filter from the skill tree
- **AND** a missing supervisor-env assignment SHALL NOT be the owner of filter discovery

#### Scenario: Operator override is preserved

- **WHEN** the operator has set `PIPELINE_MATERIAL_FILTER` to a non-empty path
- **AND** a ship progress adapter spawns the material watch
- **THEN** the adapter SHALL NOT overwrite that value
