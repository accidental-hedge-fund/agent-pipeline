## ADDED Requirements

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

#### Scenario: Missing FRG pass aborts release preparation

- **WHEN** the user runs `pipeline release 1.29.1` (or an alias that resolves to `1.29.1`)
- **AND** no FRG evidence artifact with `version: 1.29.1` and `pass: true` is available
- **THEN** the command SHALL exit non-zero naming version `1.29.1` and the missing FRG
- **AND** SHALL NOT open a release pull request as a successful unblocked completion

#### Scenario: Failed FRG aborts release preparation

- **WHEN** an FRG evidence artifact for the resolved version exists with `pass: false`
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
- **THEN** `pipeline release` SHALL exit non-zero (unparsable or not release-eligible)
- **AND** SHALL NOT treat offline/fixture scoring as a substitute for a live Layer B pack run

#### Scenario: FRG check does not auto-merge or auto-tag

- **WHEN** `pipeline release` validates an FRG pass for the resolved version
- **THEN** it SHALL NOT merge the release PR as a side effect of the FRG check
- **AND** SHALL NOT create the `vX.Y.Z` tag solely because FRG passed

---

### Requirement: The release PR surface SHALL record FRG run identity for the version

The release path SHALL include or attach the FRG `run_id` and a pass summary for version `X.Y.Z`
on the release PR surface (PR body section, automated comment, or equivalent durable PR annotation)
when `pipeline release` prepares or updates that PR after a successful FRG check. Operators and
reviewers SHALL be able to locate the FRG evidence for the version from the release PR without
private out-of-band claims.

#### Scenario: Release PR references FRG run_id

- **WHEN** `pipeline release` successfully prepares a release PR for version `1.29.1` after FRG
  pass
- **THEN** the release PR body or an attached comment SHALL include the FRG `run_id` for `1.29.1`
- **AND** SHALL indicate that the FRG result was pass

#### Scenario: Missing run_id is not silently omitted after a claimed pass

- **WHEN** the FRG check would pass but the evidence artifact lacks a usable `run_id`
- **THEN** the release path SHALL fail closed rather than open a release PR without FRG identity
