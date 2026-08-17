## Purpose

Gives a repository one optional `.github/pipeline.yml` escape that skips the Factory Reliability Gate (FRG) on `pipeline release` and `pipeline engine-promote` without repeating `--skip-frg`. Unset or false keeps FRG required.

## ADDED Requirements

### Requirement: The optional skip_frg config key SHALL default to FRG required

The pipeline config schema SHALL accept an optional top-level boolean `skip_frg` on `.github/pipeline.yml`. When the key is unset or `false`, `pipeline release` and `pipeline engine-promote` SHALL still require Factory Reliability Gate (FRG) evidence unless the operator passed `--skip-frg`. The key SHALL NOT default to `true`. `engine_track` SHALL remain pin-vs-candidate and SHALL NOT act as this gate switch.

#### Scenario: Unset key leaves FRG required

- **WHEN** `.github/pipeline.yml` has no `skip_frg` key
- **AND** the operator runs `pipeline release` or `pipeline engine-promote` without `--skip-frg`
- **THEN** the command SHALL require FRG evidence for the resolved version
- **AND** it SHALL fail closed when that evidence is missing or not a pass

#### Scenario: Explicit false leaves FRG required

- **WHEN** `.github/pipeline.yml` sets `skip_frg: false`
- **AND** the operator runs `pipeline release` or `pipeline engine-promote` without `--skip-frg`
- **THEN** the command SHALL require FRG evidence for the resolved version

### Requirement: CLI --skip-frg SHALL win over skip_frg config

The pipeline SHALL resolve FRG skip for `pipeline release` and `pipeline engine-promote` with this precedence: explicit CLI `--skip-frg` skips; else config `skip_frg: true` skips; else FRG is required. Config `false` or unset SHALL NOT force FRG on when the operator passed `--skip-frg`. Both commands SHALL use the same resolution.

#### Scenario: Config true skips without the flag

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the operator runs `pipeline release` or `pipeline engine-promote` without `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement

#### Scenario: CLI skip wins when config is false or unset

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the operator runs `pipeline release` or `pipeline engine-promote` with `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement

#### Scenario: Config cannot cancel CLI skip

- **WHEN** `.github/pipeline.yml` sets `skip_frg: false`
- **AND** the operator runs `pipeline release` or `pipeline engine-promote` with `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement
- **AND** it SHALL NOT require FRG evidence

### Requirement: A config-sourced FRG skip SHALL be logged as config

When `skip_frg: true` causes the skip and the operator did not pass `--skip-frg`, `pipeline release` and `pipeline engine-promote` SHALL log that the skip came from config. When `--skip-frg` is present, the skip log SHALL name the CLI flag even if the yml key is also true.

#### Scenario: Config-only skip names config

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the operator runs `pipeline release` or `pipeline engine-promote` without `--skip-frg`
- **THEN** the skip log SHALL name config as the source
- **AND** the skip log SHALL NOT present the skip as only `--skip-frg`

#### Scenario: CLI skip log stays CLI when both are set

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the operator also passes `--skip-frg`
- **THEN** the skip log SHALL name the CLI flag

### Requirement: Scaffold and config sync SHALL comment skip_frg off

`pipeline init` scaffold and `pipeline config sync` SHALL include `skip_frg` as a commented-off example (not an active `true` value). The comment SHALL use the schema `.describe()` text for that key. Generated `docs/config.md` SHALL document `skip_frg` from the schema.

#### Scenario: Fresh scaffold comments the key off

- **WHEN** `pipeline init` writes a new `.github/pipeline.yml`
- **THEN** the file SHALL contain a commented `skip_frg` example
- **AND** the active parsed config SHALL NOT set `skip_frg: true`

#### Scenario: Config sync comments the key off when unset

- **WHEN** `pipeline config sync` refreshes a config that does not set `skip_frg`
- **THEN** the written or previewed file SHALL show `skip_frg` commented off
- **AND** the comment SHALL include the schema description for `skip_frg`

#### Scenario: Generated config docs include the key

- **WHEN** the config reference generator runs after `skip_frg` is added to the schema
- **THEN** `docs/config.md` SHALL include `skip_frg` with a description consistent with the schema `.describe()` text

### Requirement: This factory repository SHALL NOT enable skip_frg

The committed `.github/pipeline.yml` of `accidental-hedge-fund/agent-pipeline` SHALL NOT set `skip_frg: true`. After the Tugboat default requires FRG, this factory default SHALL remain FRG-on.

#### Scenario: Factory committed config does not enable the escape

- **WHEN** the committed `.github/pipeline.yml` in this factory repository is inspected
- **THEN** it SHALL NOT contain an active `skip_frg: true`
