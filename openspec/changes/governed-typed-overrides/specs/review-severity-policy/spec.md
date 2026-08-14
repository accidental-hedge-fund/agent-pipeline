## ADDED Requirements

### Requirement: partitionFindings SHALL honor only currently valid governed overrides

When partitioning findings into blocking versus overridden sets, the engine SHALL consult the governed-override active projection (see `governed-overrides`) rather than treating every historical key or scope sentinel as unconditionally active. A finding SHALL move to the overridden set only when a currently valid active decision matches that finding by key or scope under existing match rules (including the key ambiguity guard for key dispositions and multi-match behavior for scopes). Expired, invalidated, unauthorized, superseded, rejected, or malformed decisions SHALL leave the finding in the blocking set.

#### Scenario: valid governed key override still deblocks

- **WHEN** a currently valid active decision exists for finding key `a1b2c3d4`
- **AND** exactly one live finding resolves to that key
- **THEN** `partitionFindings` SHALL place that finding in the overridden set
- **AND** SHALL NOT place it in the blocking set

#### Scenario: expired override leaves finding blocking

- **WHEN** the only matching decision for a finding is expired
- **THEN** `partitionFindings` SHALL keep that finding in the blocking set
- **AND** SHALL NOT treat the expired sentinel as an active disposition

#### Scenario: scope match still requires decision validity

- **WHEN** a scope decision matches a finding’s category or file
- **AND** the decision is invalidated by evidence-subject drift
- **THEN** the finding SHALL remain blocking despite the scope match string

#### Scenario: ambiguity guard still applies to key dispositions

- **WHEN** two distinct live findings share one key
- **AND** a valid active key decision exists for that key
- **THEN** the key override SHALL NOT be applied to any of those findings
- **AND** both findings SHALL remain blocking (unchanged ambiguity semantics)

---

### Requirement: Override recording path SHALL reject invalid governed dispositions before posting

The operator override command (including the `pipeline override` form and deprecated `--override`) SHALL run class resolution, authority, evidence, and SoD checks before posting an audited comment. On refusal, the command SHALL exit with a clear error, SHALL post no new active override comment, and SHALL leave labels and blockers unchanged with respect to that refused disposition.

#### Scenario: refused override posts nothing

- **WHEN** an operator invokes override with an unknown class or missing required evidence
- **THEN** the command SHALL fail without posting a finding-override or scope-override comment
- **AND** existing blocking findings SHALL remain blocking

#### Scenario: accepted override still posts audited comment

- **WHEN** an operator invokes a valid governed override
- **THEN** the command SHALL post an audited comment carrying the target, disposition, class (or compatibility default), reason, and machine-readable sentinel material required for later extraction
- **AND** GitHub comment authorship (or equivalent authenticated identity) SHALL remain part of the audit trail
