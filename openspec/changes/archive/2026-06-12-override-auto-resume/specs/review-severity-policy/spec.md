## MODIFIED Requirements

### Requirement: Audited operator overrides of individual findings

Each review finding SHALL be assigned a stable key derived from its content (severity, file, title) and SHALL be displayed with that key. An operator SHALL be able to disposition one finding by key via a `--override "<key>: <reason>"` invocation, which SHALL post an audited comment carrying a `pipeline-override` sentinel. The verdict gate SHALL read active overrides and exclude any finding whose key is overridden from the blocking set. The key SHALL be content-addressed so a finding re-emitted on a later commit keeps the same key and the override keeps applying. After posting the sentinel and clearing `blocked`, the pipeline SHALL automatically re-enter the advance loop (see `override-auto-resume`) — the operator does NOT need to re-invoke the pipeline manually.

#### Scenario: Overridden finding stops blocking

- **WHEN** an operator records an override for a finding's key
- **AND** a subsequent review re-emits a finding with that same key
- **THEN** that finding SHALL NOT block, and if no other finding blocks the item SHALL advance

#### Scenario: Override is auditable

- **WHEN** an override is recorded
- **THEN** it SHALL be a visible comment on the issue/PR carrying the finding key, the disposition, and the operator-supplied reason (the recording account supplies the actor)

#### Scenario: Invalid override key rejected

- **WHEN** an operator supplies an override whose key is not 8 hex characters or whose reason is empty
- **THEN** the invocation SHALL fail with a usage error and post nothing

#### Scenario: Override triggers automatic advance without re-run

- **WHEN** an operator runs `--override "<key>: <reason>"`
- **THEN** the pipeline SHALL post the sentinel and SHALL automatically re-enter the advance loop
- **AND** the operator SHALL NOT need to issue a second pipeline invocation
