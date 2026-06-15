## MODIFIED Requirements

### Requirement: Audited operator overrides of individual findings

Each review finding SHALL be assigned a stable key computed by `findingKey()` (see `stable-finding-identity` spec) and SHALL be displayed with that key in the review comment. An operator SHALL be able to disposition one finding by key via a `--override "<key>: <reason>"` invocation, which SHALL post an audited comment carrying a `pipeline-override` sentinel. The verdict gate SHALL read active overrides and exclude any finding whose key is overridden from the blocking set. The key SHALL be stable under title rewording across review rounds: a finding re-emitted with the same severity, file, and approximate line location SHALL produce the same key — the override SHALL keep applying even if the reviewer rewords the title. After posting the sentinel and clearing `blocked`, the pipeline SHALL automatically re-enter the advance loop (see `override-auto-resume`) — the operator does NOT need to re-invoke the pipeline manually.

**Key derivation:** when `line_start` is present, the key is derived from severity, normalized file, and line bucket. When `line_start` is absent, the key is derived from severity, normalized file, and normalized title. See `stable-finding-identity` for the complete normalization rules.

**Migration:** `pipeline-override` sentinels recorded before this change carry keys from the prior algorithm (severity|file|title). Those keys cease to apply after deployment; any in-flight overrides must be re-recorded.

#### Scenario: Overridden finding stops blocking

- **WHEN** an operator records an override for a finding's key
- **AND** a subsequent review re-emits exactly one finding with that same key
- **THEN** that finding SHALL NOT block, and if no other finding blocks the item SHALL advance

#### Scenario: Ambiguous override — two distinct findings share the same key

- **WHEN** an operator records an override for a finding's key
- **AND** a subsequent review emits two or more distinct findings that all resolve to that same key (same severity, file, and 5-line band but different titles)
- **THEN** the override SHALL NOT be applied to any of those findings
- **AND** all findings sharing that key SHALL remain in the blocking set

#### Scenario: Override applies despite title rewording

- **WHEN** an operator records an override for finding F in round N
- **AND** in round N+1 the reviewer re-emits the same underlying issue with a reworded title but the same severity, file, and line location (within the same 5-line band)
- **THEN** `findingKey` SHALL return the same key for both emissions
- **AND** the recorded override SHALL apply to round N+1's finding
- **AND** the item SHALL advance rather than re-park at `needs-human`

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
