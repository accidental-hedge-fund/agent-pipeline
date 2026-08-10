## ADDED Requirements

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
