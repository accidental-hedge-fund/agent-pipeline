## ADDED Requirements

### Requirement: FRG from-run throughput SHALL count GitHub ready-to-deploy as clean-ready over a stale blocked ledger

FRG throughput scoring on `factory-gate --from-run` and `factory-release prepare` (which scores through that from-run path) SHALL count a pack item as clean-ready when live GitHub shows `pipeline:ready-to-deploy` and the bound PR checks are all green, even when the durable loop ledger still records that item as `blocked` and even when the run stop is `recovery_exhausted`. The overlay SHALL be the same GitHub ready-to-deploy plus green-checks class that FRG pack collect already uses (`githubReadyToDeployOverlay` / `overlayLedgerStateFromGitHub`). Collect overlay SHALL remain. The overlay SHALL consume injected per-item GitHub observations (labels, bound PR number, checks on that PR's head). The from-run projector SHALL decide that class independently of ledger state. When that proof is absent, the overlay SHALL NOT count a ledger `ready`, `merged`, or `released` item as clean-ready: it SHALL clear `ready_clean` and project an ineligible state. When that proof is present, a ledger `merged` or `released` item SHALL stay at that terminal state and count as clean-ready. `itemsFromLoopLedger` SHALL remain a pure ledger projector and SHALL NOT read GitHub. The factory-gate `startLoop` scoring path SHALL remain ledger-only. Throughput SHALL NOT require a human `ledger.json` edit, a `ledger.stop` delete, or `pipeline unblock` as the ship-end path. Throughput SHALL NOT count `needs-human` as clean-ready. Throughput SHALL still treat an item as not clean-ready when GitHub is not ready-to-deploy, the bound PR is absent, GitHub state is missing or unreadable, or checks are not green.

#### Scenario: Sibling single finishes the pack item

- **WHEN** pack ledger item `#1290` has `state` `blocked`
- **AND** the run stop is `recovery_exhausted`
- **AND** a sibling item in the same two-item pack is already ledger-ready
- **AND** live GitHub labels for `#1290` include `pipeline:ready-to-deploy`
- **AND** the bound PR checks for `#1290` are all green
- **AND** `factory-gate --from-run` or prepare scores the bound pack
- **THEN** `clean-item-throughput` SHALL count `#1290` as clean-ready
- **AND** observed clean-ready count for that two-item pack SHALL NOT be `1` against `K=2` solely because the ledger is stale

#### Scenario: Throughput overlay matches collect overlay class

- **WHEN** live GitHub for a pack item includes `pipeline:ready-to-deploy` and green checks on the bound PR
- **AND** the durable ledger still records that item as `blocked`
- **THEN** from-run throughput scoring SHALL count the item as clean-ready
- **AND** collect SHALL still treat the same GitHub identity as finished clean at ready-to-deploy

#### Scenario: Ledger blocked without GitHub ready is not clean-ready

- **WHEN** the durable ledger item is `blocked`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: Failed or pending checks are not clean-ready

- **WHEN** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks include a failed or pending check
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready solely from the ready-to-deploy label

#### Scenario: Absent or unbound PR is not clean-ready

- **WHEN** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** there is no bound pack PR for that item, or the only green checks belong to a different PR
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: Missing or unreadable GitHub is not clean-ready

- **WHEN** the durable ledger item is `blocked`
- **AND** issue, PR, or check observations are missing or unreadable
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready
- **AND** the projector SHALL keep the ledger state for that item

#### Scenario: Missing or unbound GitHub does not count a ledger-ready item as clean-ready

- **WHEN** the durable ledger item is `ready`
- **AND** issue, PR, or check observations are missing or unreadable, or there is no bound pack PR
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready
- **AND** the overlay SHALL clear `ready_clean` and project an ineligible state

#### Scenario: Missing or invalid GitHub does not count a ledger-merged or ledger-released item as clean-ready

- **WHEN** the durable ledger item is `merged` or `released`
- **AND** issue, PR, or check observations are missing or unreadable, or there is no bound pack PR, or labels do not include `pipeline:ready-to-deploy`, or bound-PR checks are not green
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready
- **AND** the overlay SHALL clear `ready_clean` and project an ineligible state

#### Scenario: Proven GitHub class preserves ledger merged and released

- **WHEN** the durable ledger item is `merged` or `released`
- **AND** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks are all green
- **THEN** `clean-item-throughput` SHALL count that item as clean-ready
- **AND** the overlay SHALL preserve the ledger terminal state

#### Scenario: needs-human is not clean-ready

- **WHEN** live GitHub labels include `pipeline:needs-human`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: itemsFromLoopLedger stays a pure projector

- **WHEN** a caller invokes `itemsFromLoopLedger` with no GitHub observations
- **THEN** the projector SHALL return `ready_clean` from ledger `state` only
- **AND** it SHALL NOT read GitHub

#### Scenario: Next identical stale-ledger R2D pack needs no new mole

- **WHEN** a later pack item is GitHub ready-to-deploy with green checks on the bound PR
- **AND** the durable ledger still records `blocked` with stop `recovery_exhausted`
- **THEN** the same overlay SHALL count that item as clean-ready
- **AND** the ship SHALL NOT require a human `ledger.json` edit or a new mole issue to score throughput
