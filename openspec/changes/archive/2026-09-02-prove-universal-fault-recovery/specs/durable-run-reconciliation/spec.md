## MODIFIED Requirements

### Requirement: Resume-only terminal ledger-behind catch-up SHALL remain reachable on a recovery_exhausted stop

A resume-only catch-up pass SHALL repair `ledger-behind` drift to verified `ready` or `merged` when the durable run records strategy-cursor exhaustion (`recovery_exhausted` historical evidence or Cooling) and the caller is `--resume`. Default reconciliation SHALL keep refusing when a true terminal `ledger.stop` is set for non-exhaustion reasons. A live drive that first records `recovery_exhausted` SHALL remain in Cooling or an external-condition wait and SHALL NOT become a terminal run stop solely for that exhaustion. The catch-up SHALL NOT merge, push, label-write, or otherwise mutate GitHub as part of that repair. The catch-up SHALL NOT treat `needs-human` as `ready`. The catch-up SHALL NOT reopen recovery budget for items whose verified identity is not `ready` or `merged`. The catch-up SHALL NOT apply the stranded `pr_opened` / `implemented` heal to `in_progress`. Other stop reasons keep their existing law: `run_fatal` resume remains the supersede-and-re-drive path.

#### Scenario: Blocked ledger plus ready-to-deploy identity repair-forwards on resume

- **WHEN** the ledger records an item as `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** `--resume` runs the catch-up pass
- **AND** the verified identity reports ready-to-deploy (`ready_label_present`)
- **THEN** the catch-up SHALL repair-forward that item to ledger `ready`
- **AND** no GitHub write SHALL be recorded through the injected seam

#### Scenario: Blocked ledger plus merged identity repair-forwards on resume

- **WHEN** the ledger records an item as `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** `--resume` runs the catch-up pass
- **AND** the verified identity reports the PR `merged`
- **THEN** the catch-up SHALL repair-forward that item to ledger `merged`

#### Scenario: Stop alone is not a bar on resume terminal catch-up

- **WHEN** `--resume` catch-up would classify `ledger-behind` to verified `ready` or `merged`
- **AND** the only reason that pass would otherwise skip is `ledger.stop.reason = recovery_exhausted` or equivalent Cooling evidence
- **THEN** the catch-up SHALL still apply the repair
- **AND** it SHALL NOT no-op solely because that evidence is set
- **AND** default `reconcile()` SHALL still refuse when a true non-exhaustion `ledger.stop` is set

#### Scenario: Default reconcile keeps the stop guard

- **WHEN** a caller invokes default `reconcile()` on a run whose ledger carries a true terminal `stop.reason` other than strategy-cursor exhaustion
- **AND** that caller is not the resume-only catch-up pass
- **THEN** reconciliation SHALL refuse because the run is already stopped
- **AND** it SHALL NOT repair-forward items through that default entry

#### Scenario: Live exhaustion remains Cooling rather than a terminal stop

- **WHEN** a live drive first records `recovery_exhausted`
- **THEN** that drive SHALL remain in Cooling or an external-condition wait
- **AND** it SHALL NOT become a terminal run stop solely for that exhaustion
- **AND** it SHALL NOT enter the resume-only GitHub-ready catch-up as a substitute for Cooling

#### Scenario: Non-terminal blocked identity is not catch-up to ready

- **WHEN** the ledger records an item as `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** `--resume` runs the catch-up pass
- **AND** the verified identity does not report ready-to-deploy or merged
- **THEN** the catch-up SHALL NOT repair-forward that item to `ready` or `merged`

#### Scenario: Next identical exhausted-stop catch-up needs no new mole

- **WHEN** a later run records `recovery_exhausted` with a blocked ledger item whose live identity is ready-to-deploy
- **AND** an operator runs `--resume`
- **THEN** the same catch-up SHALL persist ledger `ready`
- **AND** the operator SHALL NOT need a human `ledger.json` edit or a new mole issue
