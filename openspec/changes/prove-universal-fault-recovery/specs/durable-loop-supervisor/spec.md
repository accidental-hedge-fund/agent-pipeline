## MODIFIED Requirements

### Requirement: Resume of recovery_exhausted SHALL repair-forward GitHub-ready items

`--resume` of a durable loop whose ledger records strategy-cursor exhaustion (`recovery_exhausted` historical evidence or Cooling) SHALL run a resume-only catch-up pass. That pass SHALL observe live identity through the existing observe seam and SHALL repair-forward each contract item whose verified identity is `ready` or `merged`. The supervisor SHALL NOT complete that resume as a no-op solely because `ledger.stop` is set or because Cooling is recorded. After that catch-up, each such item SHALL be ledger `ready` (or `merged`) without a human deleting `ledger.stop` or rewriting item JSON. Historical `recovery_exhausted` evidence MAY remain. Resume SHALL NOT grant extra recovery budget for remaining blocked items whose verified identity is not `ready` or `merged`. Resume SHALL NOT treat `needs-human` as ready. Resume SHALL NOT merge pack PRs. Resume SHALL NOT mutate GitHub. Resume SHALL NOT use the `run_fatal` supersede-and-re-drive path for a `recovery_exhausted` record. A live drive that records strategy-cursor exhaustion SHALL remain in Cooling (or an external-condition wait) and SHALL NOT become a terminal run stop, ownerless terminal, or human hold solely for that exhaustion.

#### Scenario: Resume repair-forwards after exhausted stop

- **WHEN** pack ledger item `#1290` has `state` `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** the verified identity for `#1290` reports `pipeline:ready-to-deploy` (ready label present)
- **AND** `pipeline loop --resume` attaches to that pack run
- **THEN** the supervisor SHALL run repair-forward for `#1290`
- **AND** `#1290` SHALL become ledger `ready` (or equivalent terminal ready state)
- **AND** the operator SHALL NOT need to delete `ledger.stop` or rewrite item JSON
- **AND** historical `recovery_exhausted` evidence MAY remain

#### Scenario: Resume does not no-op solely because stop is set

- **WHEN** `--resume` targets a run whose ledger carries `stop.reason = recovery_exhausted` or equivalent Cooling evidence
- **AND** at least one contract item has verified identity `ready` or `merged` while the ledger still records a non-terminal local state including `blocked`
- **THEN** the supervisor SHALL NOT return with zero catch-up solely because `ledger.stop` is set
- **AND** it SHALL persist the terminal ledger state for that item

#### Scenario: Remaining non-ready blocked items keep recovery exhaustion

- **WHEN** `--resume` repair-forwards a GitHub-ready item on a `recovery_exhausted` record
- **AND** another contract item remains `blocked` without verified identity `ready` or `merged`
- **THEN** the supervisor SHALL NOT treat that remaining item as ready
- **AND** that remaining item SHALL stay in Cooling or an external-condition wait
- **AND** historical `recovery_exhausted` evidence MAY remain

#### Scenario: needs-human is not repair-forwarded to ready

- **WHEN** `--resume` targets a run with `recovery_exhausted` historical evidence or Cooling
- **AND** the verified identity reports `pipeline:needs-human` and does not report ready-to-deploy or merged
- **THEN** the supervisor SHALL NOT repair-forward that item to ledger `ready`

#### Scenario: Live drive that records recovery_exhausted stays stopped

- **WHEN** a live supervisor drive first records strategy-cursor exhaustion (`recovery_exhausted` evidence)
- **THEN** that live drive SHALL remain in Cooling or an external-condition wait
- **AND** it SHALL NOT become a terminal run stop, ownerless terminal, or human hold solely for that exhaustion
- **AND** it SHALL NOT run the resume-only GitHub-ready catch-up as a substitute for Cooling
- **AND** it SHALL NOT dispatch further recovery or advance work for remaining items solely because budget exhausted

#### Scenario: run_fatal resume stays a distinct path

- **WHEN** `--resume` targets a run whose ledger carries `stop.reason = run_fatal`
- **THEN** the supervisor SHALL apply the existing `run_fatal` resume requirement
- **AND** it SHALL NOT treat that stop as `recovery_exhausted` catch-up only

#### Scenario: Repeated exhausted-stop resume is idempotent

- **WHEN** `--resume` has already repair-forwarded a GitHub-ready item on a `recovery_exhausted` record
- **AND** an operator runs `--resume` again on the same run with the same verified identity
- **THEN** that item SHALL remain ledger `ready` or `merged`
- **AND** the supervisor SHALL NOT dispatch new recovery or advance work solely because resume ran again
- **AND** historical `recovery_exhausted` evidence MAY remain

#### Scenario: Next identical exhausted-stop R2D resume needs no new mole

- **WHEN** a later pack loop records `recovery_exhausted` while GitHub already shows an item ready-to-deploy
- **AND** an operator runs `pipeline loop --resume` on that run
- **THEN** the same catch-up SHALL persist ledger `ready` for that item
- **AND** the operator SHALL NOT need a human `ledger.json` edit or a new mole issue
