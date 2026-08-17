## ADDED Requirements

### Requirement: Tugboat default skip-frg SHALL remain until one post-1.33 honest FRG pass exists

Tugboat SHALL keep the thin-path Factory Reliability Gate (FRG) skip
policy (default `--skip-frg` on `pipeline release` and
`pipeline engine-promote`) until the factory-reliability-gate honest-pass
check accepts at least one `.agent-pipeline/frg/<version>/latest.json`
for a version after `1.33.0`. This change SHALL NOT add an FRG pack
phase and SHALL NOT drop `--skip-frg` from default argv. An operator
escape with a logged reason MAY still pass `--skip-frg` after a later
child drops the default; that later child is out of scope here.

#### Scenario: Default release argv still includes skip-frg

- **WHEN** Tugboat enters the release-prepare phase
- **AND** no post-1.33 honest FRG pass exists
- **THEN** Tugboat SHALL invoke `pipeline release` with `--skip-frg`
- **AND** it SHALL NOT drop that flag as a side effect of this change

#### Scenario: Default promote argv still includes skip-frg

- **WHEN** Tugboat enters the engine-promote phase
- **AND** no post-1.33 honest FRG pass exists
- **THEN** Tugboat SHALL invoke `pipeline engine-promote` with
  `--skip-frg`
- **AND** it SHALL NOT drop that flag as a side effect of this change

#### Scenario: This change does not add the FRG pack phase

- **WHEN** this change is implemented
- **THEN** Tugboat's thin phase sequence SHALL remain train → release
  (with the existing skip policy) → CI wait → finish → publication wait
  → promote
- **AND** Tugboat SHALL NOT insert an FRG pack phase until a later
  child that consumes the honest-pass check
