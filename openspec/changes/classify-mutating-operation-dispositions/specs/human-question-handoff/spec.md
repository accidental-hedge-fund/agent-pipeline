## ADDED Requirements

### Requirement: Unblock, override, and answers SHALL resume through the typed-request contract

`pipeline unblock`, `pipeline override`, and `pipeline handoff answer` SHALL fulfill or bind a typed request and SHALL resume only through the existing handoff resume-validation contract. The pipeline SHALL NOT add a second answer ledger or a new resume CLI verb. Resume SHALL revalidate currency (answered status, SHA, bound hashes, expiry, supersession, `resume_target`, and stage preconditions) before any advance that depends on the answer. A failed resume validation SHALL refuse advance, preserve labels and durable state, and record refusal evidence. Kill-switch behavior on unblock and override SHALL remain: no GitHub mutation when the domain kill-switch file is present.

#### Scenario: Unblock uses typed-request resume

- **WHEN** an operator runs `pipeline unblock N "<answer>"` on a blocked issue
- **THEN** the answer SHALL be recorded as typed-request fulfillment
- **AND** any dependent advance SHALL pass handoff resume validation before proceeding
- **AND** the command SHALL NOT only clear `pipeline:blocked` and return without that contract

#### Scenario: Override uses typed-request resume

- **WHEN** an operator runs `pipeline override N "<key>: <reason>"`
- **THEN** the governed disposition SHALL be recorded
- **AND** auto-resume SHALL pass handoff resume validation before re-entering advance
- **AND** the command SHALL NOT invoke a command-local advance that terminalizes the run on the next mechanical fault

#### Scenario: Handoff answer remains the answer surface

- **WHEN** an eligible actor runs `pipeline handoff answer <handoff-id>`
- **THEN** the existing hash-bound answer path SHALL record the fulfillment
- **AND** resume validation SHALL be the same contract used by unblock and override
- **AND** no second answer ledger SHALL be written

#### Scenario: Stale answer still refuses resume

- **WHEN** unblock, override, or handoff answer produces a fulfillment whose candidate SHA no longer matches
- **THEN** resume validation SHALL fail
- **AND** the item SHALL NOT advance
