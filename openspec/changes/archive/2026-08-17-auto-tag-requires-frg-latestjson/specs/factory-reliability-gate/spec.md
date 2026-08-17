## ADDED Requirements

### Requirement: Shared tag-path FRG validation SHALL name the latest.json path and pack remediation

The shared release-eligible tag validator SHALL fail closed when
`.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing, unparsable, `pass: false`,
or otherwise not release-eligible for version `X.Y.Z`. The fail-closed message
SHALL name that `latest.json` path and SHALL name `factory-release prepare` or
the Tugboat FRG pack phase as the remediation. The validator SHALL NOT say FRG
is optional or advisory on the tag path. Auto-tag and any other tag-path
caller SHALL reuse this validator. They SHALL NOT invent a second tag
eligibility checker.

#### Scenario: Missing latest.json names path and remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is absent
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** the message SHALL name `factory-release prepare` or the Tugboat FRG pack phase

#### Scenario: Failed latest.json names path and remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` exists with `pass: false`
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.0/latest.json`
- **AND** the message SHALL name `factory-release prepare` or the Tugboat FRG pack phase

#### Scenario: Release-eligible pass does not emit the fail-closed remediation

- **WHEN** the shared tag validator runs for version `1.39.0`
- **AND** `.agent-pipeline/frg/1.39.0/latest.json` is release-eligible with `pass: true`
- **THEN** validation SHALL succeed
- **AND** SHALL NOT treat the artifact as a hard block

## MODIFIED Requirements

### Requirement: Ship-path skip-frg default restore SHALL stay blocked until one post-1.33 honest FRG pass exists

The pipeline SHALL treat a ship-path change that drops the default `--skip-frg` flag on Tugboat, `pipeline release`, or `engine-promote` as blocked until at least one release version after `1.33.0` has a `.agent-pipeline/frg/<version>/latest.json` that an honest-pass check accepts. After that check accepts, the factory Option 1 composer default SHALL omit `--skip-frg` and SHALL run the FRG pack phase before release. A `1.33.0`-only artifact, a `pass: false` artifact, a product-milestone loop, a caller-authored observations file, or a hand-edited `pass: true` SHALL NOT satisfy this precondition and SHALL NOT restore skip-as-default. The next identical skip-frg restore request SHALL reuse this same check and SHALL NOT require a new mole issue. Auto-tag fail-closed restore is the child of this unblock and SHALL require a release-eligible `latest.json` for the version being tagged. Pin default changes remain a sibling child.

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

#### Scenario: Unblocked ship path fail-closes auto-tag without latest.json

- **WHEN** the post-1.33 honest-pass check has already accepted and Tugboat default no-skip is in force
- **AND** a detected release merge for version `X.Y.Z` has no release-eligible `.agent-pipeline/frg/<X.Y.Z>/latest.json`
- **THEN** auto-tag SHALL fail closed
- **AND** SHALL NOT create or push `vX.Y.Z`
