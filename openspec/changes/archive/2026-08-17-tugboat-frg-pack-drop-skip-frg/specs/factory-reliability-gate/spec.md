## MODIFIED Requirements

### Requirement: Ship-path skip-frg default restore SHALL stay blocked until one post-1.33 honest FRG pass exists

The pipeline SHALL treat a ship-path change that drops the default `--skip-frg` flag on Tugboat, `pipeline release`, or `engine-promote` as blocked until at least one release version after `1.33.0` has a `.agent-pipeline/frg/<version>/latest.json` that an honest-pass check accepts. After that check accepts, the factory Option 1 composer default SHALL omit `--skip-frg` and SHALL run the FRG pack phase before release. A `1.33.0`-only artifact, a `pass: false` artifact, a product-milestone loop, a caller-authored observations file, or a hand-edited `pass: true` SHALL NOT satisfy this precondition and SHALL NOT restore skip-as-default. The next identical skip-frg restore request SHALL reuse this same check and SHALL NOT require a new mole issue. Auto-tag and pin default changes remain later children.

#### Scenario: Missing post-1.33 honest pass blocks skip-frg restore

- **WHEN** no `.agent-pipeline/frg/<version>/latest.json` after `1.33.0` passes the honest-pass check
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** Tugboat, release, and engine-promote default argv SHALL keep `--skip-frg`

#### Scenario: Accepted honest pass unblocks Tugboat default no-skip

- **WHEN** at least one `.agent-pipeline/frg/<version>/latest.json` after `1.33.0` passes the honest-pass check
- **THEN** Tugboat default release and promote argv SHALL omit `--skip-frg`
- **AND** Tugboat SHALL run the FRG pack phase before release
- **AND** the restore SHALL reuse `isHonestPost133FrgPass` (or the same check) and SHALL NOT invent a second pass definition

#### Scenario: Historical 1.33.0 pass does not satisfy the precondition

- **WHEN** `.agent-pipeline/frg/1.33.0/latest.json` exists with `pass: true`
- **AND** no later version has an accepted honest-pass artifact
- **THEN** the skip-frg default restore SHALL remain blocked

#### Scenario: Fail latest.json does not unlock skip-frg restore

- **WHEN** `.agent-pipeline/frg/1.39.0/latest.json` exists with `pass: false`
- **THEN** the skip-frg default restore SHALL remain blocked
- **AND** the artifact SHALL NOT be rewritten to `pass: true`

## ADDED Requirements

### Requirement: Per-ship FRG pack failure SHALL not restore skip-frg as the Tugboat default

When a later milestone's FRG pack fails or writes `pass: false`, the pipeline SHALL fail that ship closed. It SHALL NOT put `--skip-frg` back on Tugboat default argv. The operator escape with a logged reason remains the only skip path. A fail `latest.json` SHALL keep `pass: false`.

#### Scenario: Pack fail does not revive default skip

- **WHEN** Tugboat's FRG pack phase fails for version `1.40.0`
- **THEN** that ship SHALL stop before `pipeline release`
- **AND** default Tugboat argv for a later ship SHALL still omit `--skip-frg`
- **AND** persist SHALL NOT rewrite the fail artifact to `pass: true`
