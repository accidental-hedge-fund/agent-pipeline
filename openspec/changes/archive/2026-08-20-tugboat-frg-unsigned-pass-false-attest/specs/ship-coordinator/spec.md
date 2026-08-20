## MODIFIED Requirements

### Requirement: Ship FRG generation for post-pilot releases SHALL use the durable engine path

For target release versions after v1.33.0, the ship coordinator and any ship FRG adapter it composes (including host `pipeline-ship-frg` when used) SHALL generate release-eligible FRG evidence through the durable engine path: `pipeline factory-release prepare --request <absolute-request.json> --json` (or an in-process equivalent that implements the same protocol and shared `runRelease` handoff). They SHALL NOT use a synthetic trivial docs/fixture-only pack as release-eligible FRG generation for those versions. When FRG evidence is missing at release-prepare time, ship SHALL invoke that durable path automatically; a genuine FRG failure SHALL stop ship before release finalization. Omitted HMAC on a structurally eligible terminal pack SHALL NOT be a genuine FRG failure. That tick SHALL be attestation wait: the coordinator SHALL run `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a separate credentialed child and SHALL re-invoke the same prepare request. It SHALL NOT stop the ship as `frg_not_eligible` for omitted HMAC only.

#### Scenario: Missing FRG auto-generates via durable prepare for 1.34+

- **WHEN** an authorized ship for version `1.34.0` reaches release preparation and no release-eligible FRG pass artifact exists for `1.34.0`
- **THEN** ship SHALL invoke the durable `factory-release prepare` path (or equivalent) from the exact integrated candidate
- **AND** it SHALL NOT mint release-eligible evidence from a trivial docs-only synthetic pack

#### Scenario: Genuine FRG failure stops ship before release finalization

- **WHEN** durable FRG generation for the ship version returns failure or non-complete status because required evidence is missing or structurally ineligible (`pass: false` that is not omitted-HMAC-only)
- **THEN** ship SHALL stop before release-PR finalization mutations that require a pass
- **AND** status SHALL name the FRG defect

#### Scenario: Omitted HMAC is attestation wait not genuine failure

- **WHEN** candidate `factory-release prepare` scores a terminal structurally eligible pack without HMAC
- **THEN** ship SHALL treat the tick as attestation wait
- **AND** it SHALL NOT stop the ship as `frg_not_eligible`
- **AND** it SHALL invoke `pipeline factory-gate --for <X.Y.Z> --from-run <bound-loop>` in a child other than prepare
- **AND** that child SHALL have the producer credential

#### Scenario: Complete durable prepare supplies typed release identity

- **WHEN** `factory-release prepare` returns `status: "complete"` with typed version, PR, base, head, and FRG run id
- **THEN** ship SHALL store that identity as the release prepare result
- **AND** later finalization SHALL revalidate against the observed GitHub and FRG state before merge or promotion
