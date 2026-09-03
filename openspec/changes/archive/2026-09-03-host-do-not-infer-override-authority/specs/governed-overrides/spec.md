## ADDED Requirements

### Requirement: Agent-facing guidance SHALL NOT treat host factual judgment as override authority

Agent-facing status, recipes, and generated host SKILLs SHALL treat `pipeline override` as requiring an operator-supplied or explicitly approved exact disposition (`"<key>: <reason>"`). A host's own conclusion that a finding is stale, factually resolved, out of scope, or safe to accept SHALL NOT be presented as authorization to invent or execute that command. Existing engine governance — authenticated actor, class taxonomy, evidence, expiry, renewal-lite, supersession, subject binding, kill-switch, and typed-request auto-resume — SHALL remain unchanged. This requirement SHALL NOT add a host-identity refuse path, a host-specific allowlist, a second decision ledger, or a grant schema.

`pipeline override` SHALL remain a valid command when the operator types or explicitly approves the exact `"<key>: <reason>"` string and the invocation passes existing class policy. Recover-parked MAY continue to record audited overrides only for structured stale/DNR/below-high keys under its existing eligibility rules. HIGH, CRITICAL, security, and human-authority residuals SHALL still require a human disposition.

#### Scenario: Guidance forbids inferred override

- **WHEN** a host reads status, a blocker recipe, or a generated host SKILL after concluding a finding is factually resolved
- **THEN** that guidance SHALL NOT instruct the host to synthesize a key and reason and run `pipeline override`
- **AND** it SHALL tell the host to request the exact operator disposition if recovery left the issue parked

#### Scenario: Operator-supplied exact disposition still records

- **WHEN** an authenticated actor authorized for the class supplies the exact `"<key>: <reason>"` (and required evidence when class policy demands it)
- **THEN** the engine SHALL record the governed decision as it does today
- **AND** auto-resume SHALL still use the typed-request resume contract

#### Scenario: recover-parked eligibility is unchanged

- **WHEN** `recover-parked` classifies residual keys at live HEAD
- **THEN** stale, DNR, and below-high keys MAY still receive audited overrides
- **AND** HIGH, CRITICAL, security, and human-authority keys SHALL still be refused
- **AND** this change SHALL NOT widen those eligibility rules
