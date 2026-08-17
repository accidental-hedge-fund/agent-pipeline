## MODIFIED Requirements

### Requirement: The `release` sub-command SHALL require a Factory Reliability Gate pass for the resolved version

The live `pipeline release` path SHALL verify, after version resolution, that a Factory Reliability
Gate (FRG) evidence artifact exists for the resolved version with `pass: true` before treating the
release as ready to open an unblocked release PR (or otherwise complete the release preparation
surface that operators use to ship). When no FRG pass artifact is found, when the artifact reports
`pass: false`, or when the artifact cannot be parsed against the expected FRG schema, the command
SHALL exit non-zero with an error that names the resolved version and how to run the FRG driver
(or points at the FRG runbook). Green `npm run ci` alone SHALL NOT satisfy this check.

The FRG check is additive to the existing `npm run ci` gate: both MUST pass. The FRG check SHALL
NOT merge any pull request and SHALL NOT create the release tag by itself.

The command SHALL skip that FRG check when the shared skip resolution is active: explicit CLI
`--skip-frg`, or else `.github/pipeline.yml` `skip_frg: true` when the flag is absent. Unset or
`skip_frg: false` SHALL leave the FRG check required. When only the yml key causes the skip, the
skip log SHALL name config. Config SHALL NOT force the FRG check on if the operator passed
`--skip-frg`.

#### Scenario: Missing FRG pass aborts release preparation

- **WHEN** the user runs `pipeline release 1.29.1` (or an alias that resolves to `1.29.1`)
- **AND** no FRG evidence artifact with `version: 1.29.1` and `pass: true` is available
- **AND** `--skip-frg` is absent and `skip_frg` is unset or false
- **THEN** the command SHALL exit non-zero naming version `1.29.1` and the missing FRG
- **AND** SHALL NOT open a release pull request as a successful unblocked completion

#### Scenario: Failed FRG aborts release preparation

- **WHEN** an FRG evidence artifact for the resolved version exists with `pass: false`
- **AND** `--skip-frg` is absent and `skip_frg` is unset or false
- **THEN** `pipeline release` SHALL exit non-zero
- **AND** SHALL surface that the FRG failed rather than treating absence and failure identically
  only if both are distinguishable; either way the release MUST NOT proceed as ready

#### Scenario: FRG pass allows release preparation to continue past the FRG check

- **WHEN** an FRG evidence artifact for the resolved version exists with `pass: true`, a
  non-empty `run_id`, a non-empty durable `loop_run_id`, and validated fixed-pack provenance
- **AND** the existing `npm run ci` gate also succeeds (when that gate is reached in the release
  sequence)
- **THEN** the FRG check SHALL not block the release path
- **AND** the release preparation MAY proceed to subsequent steps defined by existing release
  requirements

#### Scenario: Offline or loop-less FRG claim does not unblock release

- **WHEN** an FRG artifact claims `pass: true` for the resolved version but lacks a usable
  durable `loop_run_id` or fixed-pack `pack_id`
- **AND** `--skip-frg` is absent and `skip_frg` is unset or false
- **THEN** `pipeline release` SHALL exit non-zero (unparsable or not release-eligible)
- **AND** SHALL NOT treat offline/fixture scoring as a substitute for a live Layer B pack run

#### Scenario: FRG check does not auto-merge or auto-tag

- **WHEN** `pipeline release` validates an FRG pass for the resolved version
- **THEN** it SHALL NOT merge the release PR as a side effect of the FRG check
- **AND** SHALL NOT create the `vX.Y.Z` tag solely because FRG passed

#### Scenario: Config skip_frg true skips the FRG check without the flag

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the user runs `pipeline release 1.29.1` without `--skip-frg`
- **AND** no FRG evidence artifact with `version: 1.29.1` and `pass: true` is available
- **THEN** the command SHALL skip the FRG check
- **AND** the skip log SHALL name config as the source

#### Scenario: CLI --skip-frg still skips when skip_frg is unset or false

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the user runs `pipeline release 1.29.1` with `--skip-frg`
- **THEN** the command SHALL skip the FRG check
