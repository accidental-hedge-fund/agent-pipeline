# supervisor-ship-playbook Specification

## Purpose
Defines how the chain-to-existing-tools supervisor ship playbook evaluates captured `pipeline train --json` output for train completeness before later ship phases, so mixed prose-plus-JSON streams do not false-fail a truly complete train.
## Requirements
### Requirement: Train completion gate SHALL evaluate the last train_status even when non-JSON prose precedes it

After the ship playbook runs `pipeline train` with JSON mode and captures stdout to the train capture file, the train completion gate SHALL decode JSON values from that capture without requiring the entire file to be a single pure JSON document. The gate SHALL locate `train_status` objects (objects whose `kind` is `train_status`) by scanning the stream, including cases where human-readable prose appears before the JSON. When more than one such object is present, the gate SHALL use the **last** one. When a decoded JSON value is an array, the gate SHALL consider objects inside that array the same way. The gate SHALL treat the train as complete only when that selected `train_status` has `complete` equal to true and has no blocker. When those conditions hold, the playbook SHALL NOT exit solely because whole-stream JSON parse of the capture file failed, and SHALL proceed past the train phase. When the selected status is incomplete or carries a blocker, the gate SHALL fail closed and SHALL NOT advance to later ship phases (release, publication wait, engine-promote).

#### Scenario: Mixed prose then complete train_status passes

- **WHEN** the train capture file contains non-JSON human-readable text followed by a `train_status` object with `complete` true and no blocker
- **THEN** the ship playbook train completion gate SHALL evaluate the train as complete
- **AND** it SHALL NOT exit with a false failure whose detail is only that the train JSON is not complete

#### Scenario: Pure JSON complete train_status still passes

- **WHEN** the train capture file is only a single `train_status` object with `complete` true and no blocker
- **THEN** the ship playbook train completion gate SHALL evaluate the train as complete

#### Scenario: Incomplete train_status fails closed

- **WHEN** the last decoded `train_status` has `complete` false or is missing
- **THEN** the ship playbook train completion gate SHALL fail the train phase
- **AND** it SHALL NOT proceed to release or engine-promote for that run

#### Scenario: Blocker on last train_status fails closed with captured detail

- **WHEN** the last decoded `train_status` has a non-null blocker
- **THEN** the ship playbook train completion gate SHALL fail the train phase
- **AND** it SHALL write the blocker value to the playbook's existing blocker side file for that capture (the path used today for train completion detail)

#### Scenario: Last train_status wins over earlier ones

- **WHEN** the capture contains more than one `train_status` object and only the last has `complete` true with no blocker
- **THEN** the gate SHALL evaluate completeness from the last `train_status`
- **AND** it SHALL NOT fail solely because an earlier `train_status` was incomplete

#### Scenario: No train_status yields incomplete

- **WHEN** the train capture file contains no decodable `train_status` object
- **THEN** the ship playbook train completion gate SHALL evaluate the train as not complete
- **AND** it SHALL fail closed

