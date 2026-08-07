## ADDED Requirements

### Requirement: A multi-change fixture SHALL declare an ordered checkpoint sequence with per-checkpoint held-out verifiers

The fixture contract SHALL admit a multi-change fixture form that declares a stable multi-change kind marker, the shared `base_commit` and common fixture identity fields required of single-task fixtures, and an ordered non-empty `checkpoints` list. Each checkpoint SHALL declare a stable `checkpoint_id` unique within the fixture, the task input disclosed only at that step, and a non-empty set of deterministic held-out verifiers for newly requested behavior at that step. Single-task fixtures that omit the multi-change form SHALL remain valid.

#### Scenario: Complete multi-change fixture is accepted

- **WHEN** a fixture declares multi-change kind, valid common identity fields including full `base_commit`, and ordered checkpoints each with unique `checkpoint_id`, disclosed task input, and held-out verifiers
- **THEN** fixture validation SHALL accept it

#### Scenario: Single-task fixtures remain valid

- **WHEN** a fixture without the multi-change form meets the existing single-task contract
- **THEN** validation SHALL accept it unchanged

#### Scenario: Empty checkpoint list is rejected

- **WHEN** a multi-change fixture declares zero checkpoints
- **THEN** validation SHALL fail naming the fixture and the checkpoints field

#### Scenario: Duplicate checkpoint ids are rejected

- **WHEN** two checkpoints share the same `checkpoint_id`
- **THEN** validation SHALL fail naming the fixture and the duplicated id

#### Scenario: Checkpoint missing held-out verifiers is rejected

- **WHEN** a checkpoint omits held-out verifiers or declares an empty set
- **THEN** validation SHALL fail naming the fixture and that `checkpoint_id`

---

### Requirement: Multi-change fixture validation SHALL reject treatment-visible leakage of held-out verifiers

For multi-change fixtures, held-out verifier definitions SHALL be disjoint from every checkpoint's treatment-visible task input and from any public checks intended for the treatment to run itself. A fixture that embeds held-out verifier bodies or identifiers into treatment-visible checkpoint task input in a way that reveals the hidden oracle SHALL be rejected naming the fixture and checkpoint.

#### Scenario: Held-out verifier content in task input is rejected

- **WHEN** a checkpoint's disclosed task input includes the text or command of a held-out verifier for that fixture
- **THEN** validation SHALL fail naming the fixture and `checkpoint_id`

---

### Requirement: A multi-change fixture SHALL be able to mark shortcut-debt, portability, and external-canary roles

The multi-change fixture form SHALL admit optional role metadata so corpus and reporting can identify: a shortcut-debt demonstration sequence; a portability-probe checkpoint (including optional weaker or cheaper model override coordinates); and an external-canary provenance or packaging mark. Role metadata SHALL NOT be required for a multi-change fixture to validate, except that when a portability model override is declared it MUST name a model coordinate the runner can apply at that checkpoint only.

#### Scenario: Portability override is scoped to the marked checkpoint

- **WHEN** a checkpoint declares a portability model override
- **THEN** validation SHALL accept the checkpoint when the override names a model coordinate
- **AND** the override SHALL be exposed to the runner as applying only to that checkpoint

#### Scenario: Role metadata is optional

- **WHEN** a multi-change fixture declares no shortcut-debt, portability, or canary role marks
- **THEN** validation SHALL succeed if the rest of the multi-change contract is met
