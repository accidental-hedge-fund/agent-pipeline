## ADDED Requirements

### Requirement: Integrated train SHALL NOT add a merge stage to STAGES

The `STAGES` constant and advance-loop terminal set SHALL remain unchanged by integrated train mode. Train orchestration SHALL live outside stage handler dispatch. Reaching `ready-to-deploy` via advance SHALL still stop the advance loop without merging; any merge performed during a train SHALL occur only through the train command's explicit merge step after that terminal stage.

#### Scenario: STAGES list is unchanged by train

- **WHEN** the train command is implemented
- **THEN** `STAGES` SHALL still terminate the happy path at `ready-to-deploy` with no merge stage entry

#### Scenario: Advance after ready-to-deploy still does not merge

- **WHEN** an issue is at `pipeline:ready-to-deploy` and only `pipeline advance` is invoked
- **THEN** the advance path SHALL not merge the pull request
- **AND** only an explicit train merge step or other loop-isolated merge command MAY merge it
