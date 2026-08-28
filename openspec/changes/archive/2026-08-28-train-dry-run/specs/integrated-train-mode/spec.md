## ADDED Requirements

### Requirement: Integrated train SHALL accept --dry-run without executing the live train

The `pipeline train` command SHALL accept `--dry-run` as a supported flag in both default and `--merge` modes. When `--dry-run` is present, the command SHALL produce the read-only plan defined by the `train-dry-run` capability and SHALL NOT advance work-list items or invoke the merge surface. When `--dry-run` is absent, existing live-train law SHALL remain unchanged.

#### Scenario: Dry-run does not advance

- **WHEN** an operator runs `pipeline train --issues 10,11 --dry-run`
- **THEN** no advance wave SHALL run
- **AND** each issue SHALL remain at its pre-invocation stage

#### Scenario: Dry-run plus merge does not merge

- **WHEN** an operator runs `pipeline train --issues 10 --merge --dry-run`
- **THEN** the linked pull request SHALL remain unmerged
- **AND** the live merge surface SHALL NOT be invoked

#### Scenario: Live train without the flag still executes

- **WHEN** an operator runs `pipeline train --issues 10,11 --json` without `--dry-run`
- **THEN** the command SHALL run the live train
- **AND** stdout SHALL still be exactly one `train_status` object when the run finishes

## MODIFIED Requirements

### Requirement: Train JSON mode SHALL emit one final object on stdout

When `pipeline train` is invoked with `--json` and without `--dry-run`, stdout SHALL contain exactly one unfenced JSON object whose `kind` is `train_status`. That object SHALL include an additive `run_id` field set to the durable train-level run ID when the train run store was initialized (`schema_version` remains `1`). When `pipeline train` is invoked with `--json` and `--dry-run`, stdout SHALL contain exactly one unfenced JSON object whose `kind` is `train_plan` as defined by the `train-dry-run` capability, and SHALL NOT emit `train_status` on that stdout stream. Nested `single` runs SHALL NOT write handoff, status, or terminal JSON objects to that stdout stream. `train_run_handoff` and train `events.jsonl` lines SHALL NOT appear on that stdout stream. Human diagnostics, `train_run_handoff`, and child progress MAY use stderr or the existing run event streams.

#### Scenario: Successful train output parses once

- **WHEN** a train advances two issues successfully with `--json`
- **THEN** one `JSON.parse` of the complete stdout SHALL return the final
  `train_status` object
- **AND** no child-run JSON SHALL precede or follow that object

#### Scenario: Child progress remains observable

- **WHEN** a child issue run emits handoff or stage progress during a JSON train
- **THEN** that progress SHALL remain available through stderr and/or the exact
  child run's events
- **AND** it SHALL NOT corrupt the final train JSON object

#### Scenario: train_status carries run_id

- **WHEN** a JSON train initializes a train run store with id `train-2026-08-28T17-28-03-000Z`
- **THEN** the stdout `train_status` object SHALL include `run_id` equal to
  `train-2026-08-28T17-28-03-000Z`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: JSON dry-run is train_plan not train_status

- **WHEN** a train is invoked with `--json` and `--dry-run` and planning succeeds
- **THEN** one `JSON.parse` of the complete stdout SHALL return an object whose `kind` is `train_plan`
- **AND** that stdout SHALL NOT contain a `train_status` object
