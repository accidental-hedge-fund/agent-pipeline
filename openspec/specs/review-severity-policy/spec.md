# review-severity-policy Specification

## Purpose
TBD - created by archiving change review-severity-policy. Update Purpose after archive.
## Requirements
### Requirement: Severity threshold gates blocking vs. advisory
A repo SHALL be able to declare `review_policy.block_threshold` (`critical` | `high` | `medium` |
`low`). A review finding whose severity rank is below the threshold SHALL be treated as **advisory**:
recorded on the PR/issue but NOT routed to a fix round. A finding whose severity rank is at or above the
threshold SHALL block (subject to the confidence floor and overrides below). An unrecognized severity
value SHALL be ranked as `medium` so it is never silently treated as the lowest severity.

#### Scenario: Sub-threshold finding is advisory
- **WHEN** a `needs-attention` verdict contains only findings whose severity is below `block_threshold`
- **THEN** the item SHALL advance to the next stage rather than route to a fix round

#### Scenario: At-or-above-threshold finding blocks
- **WHEN** a `needs-attention` verdict contains a finding whose severity is at or above `block_threshold`
- **THEN** the item SHALL route to its fix round

### Requirement: Confidence floor gates blocking vs. advisory
A repo SHALL be able to declare `review_policy.min_confidence` in `[0, 1]`. A finding whose `confidence`
is below `min_confidence` SHALL be treated as advisory even if its severity is at or above the threshold.

#### Scenario: Low-confidence finding is advisory
- **WHEN** `min_confidence` is 0.8 and a high-severity finding reports confidence 0.5
- **THEN** that finding SHALL be advisory and SHALL NOT route the item to a fix round

### Requirement: All-advisory verdict advances with an audit record
The pipeline SHALL advance an item as if approved when a `needs-attention` verdict carries findings but
none block under the active policy (all advisory or overridden), and SHALL post a machine-and-human
readable comment recording the advisory and overridden findings and the policy that applied.

#### Scenario: Advance comment records the advisory findings
- **WHEN** a review advances because all findings were sub-threshold
- **THEN** an audited comment SHALL be posted listing each advisory finding's key, severity, and the
  reason it did not block

### Requirement: Default policy preserves pre-policy behavior
The default policy SHALL be `block_threshold: "low"` and `min_confidence: 0`, under which every finding
blocks — identical to behavior before this capability. The policy SHALL be opt-in via
`.github/pipeline.yml`; an invalid `block_threshold` or out-of-range `min_confidence` SHALL be rejected
at config-parse time.

#### Scenario: No policy declared
- **WHEN** a repo declares no `review_policy`
- **THEN** every `needs-attention` finding SHALL block, as before this capability

#### Scenario: Invalid policy rejected
- **WHEN** `review_policy.block_threshold` is not one of critical/high/medium/low, or `min_confidence`
  is outside `[0, 1]`
- **THEN** config resolution SHALL fail with a validation error

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

