## ADDED Requirements

### Requirement: Terminal ledger-behind catch-up SHALL remain reachable on a recovery_exhausted stop

Reconciliation SHALL still repair `ledger-behind` drift to verified `ready` or `merged` when the durable run stop is `recovery_exhausted`. A `recovery_exhausted` stop SHALL NOT, by itself, skip that terminal catch-up. Reconciliation SHALL NOT merge, push, label-write, or otherwise mutate GitHub as part of that repair. Reconciliation SHALL NOT treat `needs-human` as `ready`. Reconciliation SHALL NOT use that catch-up to reopen recovery budget for items whose verified identity is not `ready` or `merged`. Other stop reasons keep their existing law: `run_fatal` resume remains the supersede-and-re-drive path, and a live drive that first records `recovery_exhausted` still stops under existing recovery policy.

#### Scenario: Blocked ledger plus ready-to-deploy identity repair-forwards

- **WHEN** the ledger records an item as `blocked`
- **AND** the run stop is `recovery_exhausted`
- **AND** the verified identity reports ready-to-deploy (`ready_label_present`)
- **THEN** reconciliation SHALL repair-forward that item to ledger `ready`
- **AND** no GitHub write SHALL be recorded through the injected seam

#### Scenario: Blocked ledger plus merged identity repair-forwards

- **WHEN** the ledger records an item as `blocked`
- **AND** the run stop is `recovery_exhausted`
- **AND** the verified identity reports the PR `merged`
- **THEN** reconciliation SHALL repair-forward that item to ledger `merged`

#### Scenario: Stop alone is not a bar on terminal catch-up

- **WHEN** reconciliation would classify `ledger-behind` to verified `ready` or `merged`
- **AND** the only reason that pass would otherwise skip is `ledger.stop.reason = recovery_exhausted`
- **THEN** reconciliation SHALL still apply the catch-up
- **AND** it SHALL NOT no-op solely because that stop is set

#### Scenario: Non-terminal blocked identity is not catch-up to ready

- **WHEN** the ledger records an item as `blocked`
- **AND** the run stop is `recovery_exhausted`
- **AND** the verified identity does not report ready-to-deploy or merged
- **THEN** reconciliation SHALL NOT repair-forward that item to `ready` or `merged`

#### Scenario: Next identical exhausted-stop catch-up needs no new mole

- **WHEN** a later run is stopped `recovery_exhausted` with a blocked ledger item whose live identity is ready-to-deploy
- **THEN** the same terminal catch-up SHALL persist ledger `ready`
- **AND** the operator SHALL NOT need a human `ledger.json` edit or a new mole issue
