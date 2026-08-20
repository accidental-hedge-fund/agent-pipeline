## ADDED Requirements

### Requirement: FRG from-run collect SHALL treat GitHub ready-to-deploy as ready over a stale blocked ledger

`factory-gate --from-run` and FRG pack collect SHALL re-observe live GitHub for each pack issue. When an issue carries `pipeline:ready-to-deploy` and its bound PR checks are all green, collect SHALL score that item as finished clean at ready-to-deploy even when the durable loop ledger still records `blocked` or the run stop is `recovery_exhausted`. Collect SHALL still throw when GitHub is not ready-to-deploy or checks are not green. Collect SHALL NOT require a human `ledger.json` edit or `pipeline unblock` as the ship-end path.

#### Scenario: Ledger blocked plus GitHub ready-to-deploy scores ready

- **WHEN** the durable ledger item for issue `#1158` has `state` `blocked`
- **AND** live GitHub labels include `pipeline:ready-to-deploy`
- **AND** the bound PR checks are all green
- **THEN** collect SHALL NOT throw `did not finish clean at ready-to-deploy`
- **AND** HMAC scoring SHALL proceed for that item

#### Scenario: Ledger blocked without GitHub ready still throws

- **WHEN** the durable ledger item is `blocked`
- **AND** live GitHub labels do not include `pipeline:ready-to-deploy`
- **THEN** collect SHALL throw `did not finish clean at ready-to-deploy`
