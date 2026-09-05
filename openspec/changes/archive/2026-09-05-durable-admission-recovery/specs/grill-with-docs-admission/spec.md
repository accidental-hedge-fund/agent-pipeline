## MODIFIED Requirements

### Requirement: Grill decision resolution SHALL record the recommendation package

Grill SHALL write every newly settled or requested decision node with recommendation, rationale, alternatives, risk, and verifiable evidence. Evidence embedded in an authority request SHALL be bounded and content-addressed: the node SHALL retain compact binding metadata and digests for the applicable context, dependency closure, specification, question, recommendation, candidate epoch, and authority scope rather than copying the full corpora into each request. Repeated authority nodes SHALL reuse those references and SHALL NOT duplicate the full context, dependency, or specification text. Grill SHALL use the shared typed-request-resolution classifier rather than a grill-only predicate copy. A newly written resolution that omits the required package, digest, or binding SHALL fail closed.

The canonical rendered issue body SHALL remain within GitHub's accepted issue-body size while preserving enough digests and metadata to verify every decision and handoff binding. If the bounded representation still cannot fit, grill SHALL return a typed validation or publication failure and SHALL NOT truncate away required evidence or promote the issue to `pipeline:ready`.

#### Scenario: Auto-accept records the package

- **WHEN** grill auto-settles a reversible in-scope recommendation
- **THEN** the Decisions node SHALL record recommendation, rationale, alternatives, risk, and bounded verifiable evidence
- **AND** provenance SHALL remain `settled-by: auto-accept`

#### Scenario: Repeated authority requests reuse content addresses

- **WHEN** multiple AuthorityRequest nodes depend on the same context, dependency closure, or specification corpus
- **THEN** each node SHALL carry the required compact digest and binding metadata
- **AND** SHALL NOT copy that full shared corpus into every node

#### Scenario: DecisionRequest records the package

- **WHEN** grill creates a `DecisionRequest` for contradictory requirements
- **THEN** the node SHALL record recommendation, rationale, alternatives, risk, and bounded verifiable evidence
- **AND** `typed_request` SHALL be `DecisionRequest`

#### Scenario: Oversized rendered body fails without evidence truncation

- **WHEN** the canonical bounded Decisions render would still exceed GitHub's issue-body limit
- **THEN** grill SHALL return a typed failure before ready promotion
- **AND** SHALL NOT silently truncate required evidence, digests, or handoff bindings

## ADDED Requirements

### Requirement: Grill SHALL publish generated issue bodies without placing the body in argv

Every grill path that writes generated issue-body Markdown, including initial apply, resume, migration, and handoff materialization, SHALL send the body through stdin, a body file, or an equivalent non-argv channel. The transport SHALL support a valid body above the prior operating-system argv failure threshold. The injectable publication seam SHALL expose the transport channel and result so hermetic tests can prove that no argv element contains the generated body.

Publication failure SHALL return an actionable typed classification with bounded diagnostics. An operating-system spawn failure, including a result with null status, SHALL be classified as a spawn or transport failure and SHALL NOT be reported as success, as an ordinary GitHub rejection with a misleading numeric exit, or as an unowned lifecycle outcome. The issue SHALL not be promoted to `pipeline:ready`, and RecoverySupervisor SHALL retain ownership unless a genuine typed request independently applies.

#### Scenario: Large generated body uses non-argv transport

- **WHEN** grill publishes valid generated Markdown larger than the prior argv failure threshold
- **THEN** publication SHALL deliver the complete body through a non-argv channel
- **AND** no process argument SHALL contain that body
- **AND** successful GitHub acknowledgement SHALL allow the normal post-write verification to continue

#### Scenario: Null-status spawn failure remains typed

- **WHEN** the operating system fails to spawn the publication command and returns null status
- **THEN** grill SHALL return a typed spawn or transport failure with actionable diagnostics
- **AND** SHALL NOT render the outcome as success or as `exit null`
- **AND** the admitted operation SHALL remain durably owned

#### Scenario: All grill body writers share the transport

- **WHEN** a contract test enumerates initial apply, resume, migration, and handoff materialization body-write routes
- **THEN** every route SHALL use the shared non-argv publication contract
- **AND** a newly added argv-body route SHALL fail the repository hard gate
