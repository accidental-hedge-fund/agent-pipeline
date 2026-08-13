## ADDED Requirements

### Requirement: Triggered work SHALL produce a compact pre-code design dossier before implementing

When pre-code attestation trigger evaluation returns `triggered: true`, the pipeline SHALL require a
schema-versioned compact design dossier before implementation begins. The dossier SHALL be part of
the existing plan/evidence artifact graph and SHALL NOT require separate mandatory Product,
Architecture, Program Design, or Vertical Slice pipeline stages. Untriggered or disabled gate paths
SHALL NOT require a dossier.

#### Scenario: triggered run requires dossier before implementing

- **WHEN** the pre-code gate is triggered
- **AND** no validated dossier exists for the current plan revision
- **THEN** the engine SHALL NOT enter `implementing`
- **AND** the implementer or planning surface SHALL be required to produce a dossier that validates against the dossier schema

#### Scenario: untriggered run does not require dossier

- **WHEN** the pre-code gate is disabled or no trigger matches
- **THEN** the engine SHALL advance without requiring a design dossier

#### Scenario: dossier remains on plan/evidence surface

- **WHEN** a dossier is produced for a triggered run
- **THEN** it SHALL be stored and referenced via the plan/evidence artifact path used by the run
- **AND** the pipeline SHALL NOT require four additional stage labels solely to hold dossier sections

---

### Requirement: The dossier schema SHALL capture intent, boundary, delta, and vertical slices

A valid dossier with `schema_version: 1` SHALL include at least:

- intended user outcome, and a rough UI mockup reference when the work is UI-facing
- system boundary and key interaction sequence
- expected call-stack and file-tree delta
- key types, contracts, interfaces, and signatures
- one or more independently testable vertical slices

Malformed or incomplete dossiers SHALL fail validation and SHALL NOT be eligible for attestation.

#### Scenario: complete dossier validates

- **WHEN** a dossier includes intent, system boundary, interaction sequence, expected delta, key contracts, and at least one vertical slice meeting the slice schema
- **THEN** dossier validation SHALL succeed

#### Scenario: missing slices fails validation

- **WHEN** a dossier omits `slices` or supplies an empty slices array
- **THEN** dossier validation SHALL fail
- **AND** the dossier SHALL NOT be eligible for human approval

#### Scenario: UI work without mockup reference fails or warns per schema rules

- **WHEN** the dossier marks the work as UI-facing and omits a rough mockup reference
- **THEN** validation SHALL fail or require an explicit documented exception field
- **AND** silent omission SHALL NOT pass validation

---

### Requirement: Each slice SHALL represent an explicit behavior diff of additions, changes, or removals

Each vertical slice SHALL include one or more behavior-diff entries. Each entry SHALL declare
`op` as exactly one of `addition`, `change`, or `removal` against the repository's accepted
behavior, and SHALL identify the target contract or behavior identity being added, changed, or
removed.

#### Scenario: addition, change, and removal are accepted ops

- **WHEN** a slice includes behavior diffs with ops `addition`, `change`, and `removal`
- **THEN** validation SHALL accept those ops when other required fields are present

#### Scenario: unknown op is rejected

- **WHEN** a behavior diff declares `op: rewrite` or any value outside `addition|change|removal`
- **THEN** dossier validation SHALL fail

#### Scenario: missing target identity is rejected

- **WHEN** a behavior diff omits the target contract or behavior identity
- **THEN** dossier validation SHALL fail

---

### Requirement: Each slice SHALL carry structured behavioral contracts

Each vertical slice SHALL contain structured behavioral contracts covering the happy path and the
relevant failure, retry, and concurrency cases for that slice. Each contract SHALL include:

- preconditions
- command or input
- expected state, output, or event
- ownership boundary
- relevant failure, retry, and concurrency behavior notes
- `origin` of `stated` or `derived`
- verification reference or `Untestable:` reason

#### Scenario: happy path and failure contracts are present

- **WHEN** a slice validates successfully
- **THEN** it SHALL include at least one happy-path behavioral contract
- **AND** it SHALL include failure, retry, or concurrency contracts when those cases are relevant to the slice, or an explicit documented omission with justification when not applicable

#### Scenario: missing required contract fields fails validation

- **WHEN** a behavioral contract omits preconditions, command/input, expected outcome, ownership boundary, origin, or verification
- **THEN** dossier validation SHALL fail

---

### Requirement: Derived behaviors SHALL require explicit accept or reject at attestation

Any behavior inferred from the issue, repository, or surrounding context rather than explicitly stated by the requester SHALL be marked `origin: derived`. During attestation, each derived behavior SHALL receive an explicit `accept` or `reject` disposition. Rejected derived behaviors SHALL NOT remain in the approved dossier set. Pending derived dispositions SHALL block approval.

#### Scenario: derived behavior pending blocks approval

- **WHEN** the dossier contains a derived behavior without accept or reject disposition
- **THEN** attestation approval SHALL be refused
- **AND** the issue SHALL NOT enter `implementing`

#### Scenario: rejected derived behavior is excluded from approved set

- **WHEN** an attestor rejects a derived behavior
- **THEN** the approved dossier revision SHALL NOT include that behavior as accepted work
- **AND** evidence SHALL record the rejection

#### Scenario: accepted derived behavior remains marked derived

- **WHEN** an attestor accepts a derived behavior
- **THEN** the approved record SHALL retain `origin: derived`
- **AND** SHALL record the accept disposition

#### Scenario: stated behavior does not require derived disposition

- **WHEN** a behavior is marked `origin: stated`
- **THEN** validation SHALL NOT require a derived accept/reject field for that behavior

---

### Requirement: Verification references SHALL be repo-native or explicit Untestable reasons

Each behavioral contract SHALL identify a repository-native verification reference (test, eval,
schema, OpenSpec scenario, or other repo-owned evidence) **or** carry an explicit `Untestable:`
reason. The pipeline SHALL NOT require a universal requirements syntax (such as EARS) or a specific
application framework. Contracts SHALL be machine-checkable enough to trace an approved contract
through implementation, review, verification, and shipcheck evidence via stable objective IDs and
content hashes.

#### Scenario: test reference is accepted

- **WHEN** a contract sets verification to a repo-native test path or stable test identity
- **THEN** validation SHALL accept the verification field

#### Scenario: untestable reason requires human affirmation

- **WHEN** a contract uses an `Untestable:` reason
- **THEN** approval SHALL require an authorized human affirmation of that exception on the attestation record
- **AND** downstream evidence SHALL mark the contract as `unverified_exception`
- **AND** downstream evidence SHALL NOT report the contract as test-proven

#### Scenario: missing verification fails validation

- **WHEN** a contract has neither a verification reference nor an `Untestable:` reason
- **THEN** dossier validation SHALL fail

---

### Requirement: Approved contracts SHALL form a compact objective manifest for downstream traceability

From an approved dossier, the engine SHALL derive a compact objective manifest of stable
`objective_id` values and content hashes for each accepted behavioral contract. Downstream
implementation and verification evidence SHALL be able to reference those IDs. For a triggered run,
missing final verification or missing explicit `unverified_exception` disposition for an approved
objective SHALL fail safely at readiness composition. The objective manifest SHALL NOT introduce a
second planning state machine.

#### Scenario: objective ids are stable across resume

- **WHEN** a dossier is rehydrated after an interrupted run without content change
- **THEN** each accepted contract's `objective_id` and content hash SHALL match the prior revision

#### Scenario: missing verification trace fails safely

- **WHEN** a triggered run reaches readiness composition with an approved objective that has neither passing verification evidence nor an `unverified_exception` disposition
- **THEN** readiness composition SHALL fail safely
- **AND** evidence SHALL name the missing objective id

#### Scenario: untestable exception remains unverified

- **WHEN** an approved contract carries an affirmed `Untestable:` exception
- **THEN** final evidence for that objective SHALL remain `unverified_exception`
- **AND** SHALL NOT be labeled as test-proven
)
