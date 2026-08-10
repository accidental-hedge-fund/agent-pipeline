# ship-coordinator Specification

## Purpose

Provide one small, restart-safe Pipeline command that composes existing train,
recovery, FRG, release, publication, and engine-promotion capabilities. Channel
adapters stay thin, and systemd remains the host process supervisor.
## Requirements
### Requirement: The CLI SHALL provide one explicit ship coordinator

The CLI SHALL expose `pipeline ship --milestone <title> --for <X.Y.Z>
--authorization <absolute-json> --json`. It SHALL compose the existing
integrated train in merge mode, bounded Pipeline recovery, candidate-bound FRG
validation, release prepare and finish, publication verification, and
`engine-promote`. It SHALL NOT reimplement stage dispatch, merge gates, FRG
scoring, release mutation, retry taxonomy, or install behavior.

The command SHALL remain loop-isolated: `advance`, `single`, and `loop` SHALL
never invoke it. It SHALL require the explicit bounded authorization before any
merge, release-finalization, promotion, or install mutation.

#### Scenario: One command composes existing lifecycle utilities

- **WHEN** an authorized operator runs the ship command for milestone M and
  version V
- **THEN** the coordinator SHALL call the existing Pipeline implementations for
  each lifecycle phase
- **AND** it SHALL NOT create a second issue scheduler, merge implementation,
  FRG scorer, release builder, or model router

#### Scenario: Advance surfaces do not acquire ship authority

- **WHEN** `pipeline advance`, `pipeline single`, or `pipeline loop` reaches
  `pipeline:ready-to-deploy`
- **THEN** it SHALL still stop without invoking the ship coordinator

---

### Requirement: Ship state SHALL be typed, atomic, and restart-safe

The coordinator SHALL persist one atomic typed state record keyed by repository,
base branch, milestone, and version. The record SHALL bind the accepted signed
authorization fingerprint and SHALL reject a replacement while that grant is
active. After expiry, it MAY accept a new signed grant for the same coordinates
without widening the frozen issue plan. The record SHALL include at
least `schema_version`, `kind`, repository, base, milestone, version, phase,
event identity, authorization fingerprint, exact child run identities, current
candidate identity, release PR identity when known, and terminal result when
known. It SHALL treat GitHub and Pipeline artifacts as authoritative and use the
record only as a restart checkpoint.

Before each external mutation, including after process restart, it SHALL
re-observe the relevant issue, PR, base, FRG, publication, pin, and installed
engine state. A completed observation SHALL advance the checkpoint without
repeating the mutation. Ambiguous or mismatched identity SHALL fail closed.
The coordinator SHALL resolve and atomically store the ordered milestone issue
plan before the first train mutation. A restart SHALL reuse that exact plan;
later milestone assignments SHALL NOT widen the accepted shipment.

#### Scenario: Restart after an external side effect reconciles

- **WHEN** the process stops after a train merge, release PR creation, release
  merge, publication, pin update, or install but before the next checkpoint
- **THEN** a restart SHALL observe the completed side effect and continue
- **AND** it SHALL NOT perform the same mutation twice

#### Scenario: Candidate drift fails closed

- **WHEN** the observed release PR head, base, or release version differs from
  the typed prepare identity stored by the ship
- **THEN** the coordinator SHALL stop with a typed identity error before merge

#### Scenario: Later milestone assignment does not widen the ship

- **WHEN** the coordinator has stored its ordered issue plan
- **AND** another issue is later assigned to the same GitHub milestone
- **THEN** a restart SHALL continue only the stored issue plan
- **AND** it SHALL NOT merge the later issue under the accepted authorization

---

### Requirement: Ship status SHALL expose the exact run without mutation

`pipeline ship status --milestone <title> --for <X.Y.Z> --json` SHALL read the
matching ship record without requiring chat memory or scanning host-global
latest-run directories. JSON output SHALL be one unfenced object and SHALL
include the ship phase, terminal result, blocker when present, exact child run
identities, current issue or candidate when present, release PR identity when
present, and next deterministic action.

#### Scenario: Status selects by stable coordinates

- **WHEN** another unrelated Pipeline run is active on the same host
- **AND** an adapter requests ship status with the original milestone and
  version
- **THEN** the response SHALL describe only that ship and its recorded child
  runs

#### Scenario: Status is observational

- **WHEN** an adapter polls ship status
- **THEN** the request SHALL perform no train, merge, release, promotion, or
  install mutation

---

### Requirement: Host adapters SHALL use systemd only for process supervision

A Buzz/Hermes or other channel adapter SHALL authenticate and normalize intent,
write the bounded authorization document, start one stable transient systemd user unit
without waiting for terminal completion, and render typed status plus
material-filtered exact-run events. Pipeline SHALL hold one host-local writer
lock for each repository/base across foreground and detached calls. systemd
SHALL own bounded abnormal-process restart, PID tracking, cancellation, logs,
and service lifetime. The adapter
SHALL NOT implement its own durable scheduler, PID registry, lifecycle state
machine, merge policy, release discovery, retry policy, or event attribution.

#### Scenario: Accepted command returns after admission

- **WHEN** a valid signed Buzz ship command is admitted
- **THEN** the adapter SHALL start the matching systemd unit and return an
  accepted response without waiting for the ship to finish
- **AND** subsequent progress SHALL come from typed ship status and exact-run
  material events

#### Scenario: systemd restart resumes one ship

- **WHEN** the ship process exits unexpectedly and systemd restarts its unit
- **THEN** the same milestone, version, and authorization coordinates SHALL
  resume the same Pipeline ship record
- **AND** the adapter SHALL NOT create a parallel wrapper-local run

### Requirement: Ship FRG generation for post-pilot releases SHALL use the durable engine path

For target release versions after v1.33.0, the ship coordinator and any ship FRG adapter it composes (including host `pipeline-ship-frg` when used) SHALL generate release-eligible FRG evidence through the durable engine path: `pipeline factory-release prepare --request <absolute-request.json> --json` (or an in-process equivalent that implements the same protocol and shared `runRelease` handoff). They SHALL NOT use a synthetic trivial docs/fixture-only pack as release-eligible FRG generation for those versions. When FRG evidence is missing at release-prepare time, ship SHALL invoke that durable path automatically; a genuine FRG failure SHALL stop ship before release finalization.

#### Scenario: Missing FRG auto-generates via durable prepare for 1.34+

- **WHEN** an authorized ship for version `1.34.0` reaches release preparation and no release-eligible FRG pass artifact exists for `1.34.0`
- **THEN** ship SHALL invoke the durable `factory-release prepare` path (or equivalent) from the exact integrated candidate
- **AND** it SHALL NOT mint release-eligible evidence from a trivial docs-only synthetic pack

#### Scenario: Genuine FRG failure stops ship before release finalization

- **WHEN** durable FRG generation for the ship version returns failure or non-complete status because required evidence is missing or `pass: false`
- **THEN** ship SHALL stop before release-PR finalization mutations that require a pass
- **AND** status SHALL name the FRG defect

#### Scenario: Complete durable prepare supplies typed release identity

- **WHEN** `factory-release prepare` returns `status: "complete"` with typed version, PR, base, head, and FRG run id
- **THEN** ship SHALL store that identity as the release prepare result
- **AND** later finalization SHALL revalidate against the observed GitHub and FRG state before merge or promotion

### Requirement: Ship durable FRG handoff SHALL remain restart-safe and non-duplicating

When ship drives the durable FRG and prepare protocol, every entry after crash, timeout, or restart SHALL re-observe pack, FRG run, attestation, branch, release PR, and head state before any create mutation. Duplicate ticks with the same ship coordinates and request binding SHALL NOT create a second pack, second attestation, second release branch, or second release PR.

#### Scenario: Restart after awaiting attestation continues without new pack

- **WHEN** ship stopped after unsigned FRG artifacts exist and status was `awaiting_frg_attestation`
- **AND** a restart runs the same ship coordinates and request binding
- **THEN** ship SHALL re-observe the existing pack and artifacts
- **AND** it SHALL NOT create a second pack for the same binding

#### Scenario: Restart after complete prepare does not open a second PR

- **WHEN** ship stopped after a complete prepare with a known release PR identity
- **AND** a restart re-enters release preparation
- **THEN** ship SHALL reconcile the existing PR identity
- **AND** it SHALL NOT open a second release pull request for the same version binding

