## ADDED Requirements

### Requirement: Engine-promote SHALL require FRG unless the resolved skip is active

The live `pipeline engine-promote` path SHALL require Factory Reliability Gate (FRG) evidence for the target version unless the shared skip resolution is active: explicit CLI `--skip-frg`, or else `.github/pipeline.yml` `skip_frg: true` when the flag is absent. Unset or `skip_frg: false` SHALL leave FRG required. When only the yml key causes the skip, the skip log SHALL name config. Config SHALL NOT force FRG on if the operator passed `--skip-frg`.

#### Scenario: Unset or false still requires FRG without the flag

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` without `--skip-frg`
- **AND** no FRG pass artifact for `X.Y.Z` is available
- **THEN** the command SHALL fail closed and SHALL NOT promote the pin as a successful unblocked completion

#### Scenario: Config skip_frg true skips FRG without the flag

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` without `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement
- **AND** the skip log SHALL name config as the source

#### Scenario: CLI --skip-frg still skips when skip_frg is unset or false

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` with `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement
