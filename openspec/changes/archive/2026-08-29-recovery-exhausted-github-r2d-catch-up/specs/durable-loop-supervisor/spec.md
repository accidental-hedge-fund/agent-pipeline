## ADDED Requirements

### Requirement: Resume of recovery_exhausted SHALL repair-forward GitHub-ready items

`--resume` of a durable loop whose ledger stop is `recovery_exhausted` SHALL run a resume-only terminal catch-up pass. That pass SHALL observe live identity through the existing observe seam and SHALL repair-forward each contract item whose verified identity is `ready` or `merged`. The supervisor SHALL NOT complete that resume as a no-op solely because `ledger.stop` is set. After that catch-up, each such item SHALL be ledger `ready` (or `merged`) without a human deleting `ledger.stop` or rewriting item JSON. `ledger.stop` SHALL remain as historical evidence with the original `recovery_exhausted` record. Resume SHALL NOT grant extra recovery budget for remaining blocked items whose verified identity is not `ready` or `merged`. Resume SHALL NOT treat `needs-human` as ready. Resume SHALL NOT merge pack PRs. Resume SHALL NOT dispatch new recovery or advance work. Resume SHALL NOT mutate GitHub. Resume SHALL NOT use the `run_fatal` supersede-and-re-drive path for a `recovery_exhausted` stop. A live drive that first records `recovery_exhausted` SHALL remain stopped and SHALL NOT enter this catch-up.

#### Scenario: Resume repair-forwards after exhausted stop

- **WHEN** pack ledger item `#1290` has `state` `blocked`
- **AND** the run stop is `recovery_exhausted`
- **AND** the verified identity for `#1290` reports `pipeline:ready-to-deploy` (ready label present)
- **AND** `pipeline loop --resume` attaches to that pack run
- **THEN** the supervisor SHALL run repair-forward for `#1290`
- **AND** `#1290` SHALL become ledger `ready` (or equivalent terminal ready state)
- **AND** the operator SHALL NOT need to delete `ledger.stop` or rewrite item JSON
- **AND** `ledger.stop.reason` SHALL remain `recovery_exhausted`

#### Scenario: Resume does not no-op solely because stop is set

- **WHEN** `--resume` targets a run whose ledger carries `stop.reason = recovery_exhausted`
- **AND** at least one contract item has verified identity `ready` or `merged` while the ledger still records a non-terminal local state including `blocked`
- **THEN** the supervisor SHALL NOT return with zero catch-up solely because `ledger.stop` is set
- **AND** it SHALL persist the terminal ledger state for that item

#### Scenario: Remaining non-ready blocked items keep recovery exhaustion

- **WHEN** `--resume` repair-forwards a GitHub-ready item on a `recovery_exhausted` stop
- **AND** another contract item remains `blocked` without verified identity `ready` or `merged`
- **THEN** the supervisor SHALL NOT dispatch new recovery or advance work for that remaining item solely because resume ran
- **AND** it SHALL NOT treat that remaining item as ready
- **AND** `ledger.stop` SHALL remain `recovery_exhausted`

#### Scenario: needs-human is not repair-forwarded to ready

- **WHEN** `--resume` targets a run stopped `recovery_exhausted`
- **AND** the verified identity reports `pipeline:needs-human` and does not report ready-to-deploy or merged
- **THEN** the supervisor SHALL NOT repair-forward that item to ledger `ready`

#### Scenario: Live drive that records recovery_exhausted stays stopped

- **WHEN** a live supervisor drive first records `ledger.stop.reason = recovery_exhausted`
- **THEN** that live drive SHALL stop
- **AND** it SHALL NOT run the resume-only terminal catch-up
- **AND** it SHALL NOT dispatch further recovery or advance work for remaining items

#### Scenario: run_fatal resume stays a distinct path

- **WHEN** `--resume` targets a run whose ledger carries `stop.reason = run_fatal`
- **THEN** the supervisor SHALL apply the existing `run_fatal` resume requirement
- **AND** it SHALL NOT treat that stop as `recovery_exhausted` terminal catch-up only

#### Scenario: Repeated exhausted-stop resume is idempotent

- **WHEN** `--resume` has already repair-forwarded a GitHub-ready item on a `recovery_exhausted` stop
- **AND** an operator runs `--resume` again on the same run with the same verified identity
- **THEN** that item SHALL remain ledger `ready` or `merged`
- **AND** the supervisor SHALL NOT dispatch new recovery or advance work
- **AND** `ledger.stop.reason` SHALL remain `recovery_exhausted`

#### Scenario: Next identical exhausted-stop R2D resume needs no new mole

- **WHEN** a later pack loop stops `recovery_exhausted` while GitHub already shows an item ready-to-deploy
- **AND** an operator runs `pipeline loop --resume` on that run
- **THEN** the same catch-up SHALL persist ledger `ready` for that item
- **AND** the operator SHALL NOT need a human `ledger.json` edit or a new mole issue
