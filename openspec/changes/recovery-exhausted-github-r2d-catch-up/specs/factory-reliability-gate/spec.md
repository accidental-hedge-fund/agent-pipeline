## ADDED Requirements

### Requirement: FRG throughput SHALL count GitHub ready-to-deploy as clean-ready over a stale blocked ledger

FRG throughput scoring SHALL count a pack item as clean-ready when live GitHub shows `pipeline:ready-to-deploy` and the bound PR checks are all green, even when the durable loop ledger still records that item as `blocked` and even when the run stop is `recovery_exhausted`. `factory-gate --from-run`, `factory-release prepare` scoring of a bound pack, and every other consumer that projects pack items from the durable loop ledger for `clean-item-throughput` SHALL apply this overlay. The overlay SHALL be the same GitHub ready-to-deploy plus green-checks class that FRG pack collect already uses. Collect overlay SHALL remain. Throughput SHALL NOT require a human `ledger.json` edit, a `ledger.stop` delete, or `pipeline unblock` as the ship-end path. Throughput SHALL NOT count `needs-human` as clean-ready. Throughput SHALL still treat an item as not clean-ready when GitHub is not ready-to-deploy or checks are not green.

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

- **WHEN** live GitHub for a pack item includes `pipeline:ready-to-deploy` and green checks
- **AND** the durable ledger still records that item as `blocked`
- **THEN** throughput scoring SHALL count the item as clean-ready
- **AND** collect SHALL still treat the same GitHub identity as finished clean at ready-to-deploy

#### Scenario: Ledger blocked without GitHub ready is not clean-ready

- **WHEN** the durable ledger item is `blocked`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: Failed or pending checks are not clean-ready

- **WHEN** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks include a failed or pending check
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready solely from the ready-to-deploy label

#### Scenario: needs-human is not clean-ready

- **WHEN** live GitHub labels include `pipeline:needs-human`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** `clean-item-throughput` SHALL NOT count that item as clean-ready

#### Scenario: Next identical stale-ledger R2D pack needs no new mole

- **WHEN** a later pack item is GitHub ready-to-deploy with green checks
- **AND** the durable ledger still records `blocked` with stop `recovery_exhausted`
- **THEN** the same overlay SHALL count that item as clean-ready
- **AND** the ship SHALL NOT require a human `ledger.json` edit or a new mole issue to score throughput
