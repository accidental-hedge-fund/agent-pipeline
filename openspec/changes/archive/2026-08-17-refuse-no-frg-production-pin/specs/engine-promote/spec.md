## MODIFIED Requirements

### Requirement: Engine-promote SHALL require FRG unless the resolved skip is active

The live `pipeline engine-promote` path SHALL require Factory Reliability Gate (FRG) evidence for the target version unless the shared skip resolution is active: explicit CLI `--skip-frg`, or else `.github/pipeline.yml` `skip_frg: true` when the flag is absent. Unset or `skip_frg: false` SHALL leave FRG required. When only the yml key causes the skip, the skip log SHALL name config. Config SHALL NOT force FRG on if the operator passed `--skip-frg`.

A successful **non-skip** promote SHALL write a production-quality pin: `frg_run_id` SHALL equal the FRG evidence `run_id` and SHALL NOT start with `no-frg-`, and `frg_evidence_path` SHALL be non-null. When skip is active, the path MAY write a clearly marked non-production-quality pin (`frg_run_id` `no-frg-<X.Y.Z>`, `frg_evidence_path` null). Default promote SHALL fail closed instead of writing that marker.

When the live pin is already at the target version and tag, engine-promote SHALL treat that pin as already-current success only if the pin is production-quality, or if the resolved skip is active. A same-version `no-frg-*` / null-evidence pin SHALL NOT count as already-current success on the default path. Default promote SHALL then refuse, or re-promote from a real FRG pass for that version.

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
- **AND** a written pin SHALL be marked non-production-quality (`no-frg-X.Y.Z`, null evidence)

#### Scenario: CLI --skip-frg still skips when skip_frg is unset or false

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` with `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement
- **AND** a written pin SHALL be marked non-production-quality (`no-frg-X.Y.Z`, null evidence)

#### Scenario: Non-skip success writes real FRG fields

- **WHEN** the operator runs `pipeline engine-promote --for 1.37.0` without resolved skip
- **AND** FRG evidence for `1.37.0` exists with `pass: true` and `run_id` `frg-abc`
- **THEN** the written pin SHALL set `frg_run_id` to `frg-abc`
- **AND** SHALL set `frg_evidence_path` to a non-null path
- **AND** SHALL NOT set `frg_run_id` to `no-frg-1.37.0`

#### Scenario: Same-version no-frg pin is not already-current success

- **WHEN** the live pin already names version `1.37.0` and tag `v1.37.0`
- **AND** that pin has `frg_run_id` `no-frg-1.37.0` or `frg_evidence_path` null
- **AND** the operator runs `pipeline engine-promote --for 1.37.0` without resolved skip
- **THEN** the command SHALL NOT treat the pin as already-current success
- **AND** it SHALL refuse, or re-promote from a real FRG pass for `1.37.0`
