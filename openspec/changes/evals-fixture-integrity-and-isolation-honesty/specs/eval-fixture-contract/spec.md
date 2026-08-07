## ADDED Requirements

### Requirement: A fixture with empty grader references SHALL carry an explicit smoke-only mark

A fixture whose `grader_refs` array is empty SHALL declare an explicit smoke-only mark in the
fixture record (a dedicated field or equivalent contract-level mark exposed on the loaded
fixture). Fixture validation SHALL reject an empty `grader_refs` array that lacks the smoke-only
mark, naming the fixture and the inconsistency. Fixture validation SHALL reject a non-empty
`grader_refs` array that is marked smoke-only, naming the fixture. Loaders and reporting SHALL
expose the smoke-only mark so smoke fixtures are distinguishable from graded fixtures without
reading prose documentation alone.

#### Scenario: Empty grader_refs with smoke-only mark is accepted

- **WHEN** a fixture declares `grader_refs: []` and an explicit smoke-only mark
- **THEN** fixture validation SHALL succeed
- **AND** the loaded fixture SHALL expose the smoke-only mark to runners and reporting

#### Scenario: Empty grader_refs without smoke-only mark is rejected

- **WHEN** a fixture declares `grader_refs: []` and omits the smoke-only mark
- **THEN** fixture validation SHALL fail naming the fixture and the missing smoke-only mark

#### Scenario: Graded fixture cannot be marked smoke-only

- **WHEN** a fixture declares one or more `grader_refs` and is also marked smoke-only
- **THEN** fixture validation SHALL fail naming the fixture and the inconsistent combination

---

### Requirement: A fixture base_commit SHALL be an object the corpus policy can materialize

A fixture `base_commit` SHALL be materializable as a git commit object in the environments that
run doctor, CI, and evaluation, in addition to being a full immutable commit SHA at load time —
either because the object is present in a full clone of the repository, or because the fixture
declares an explicit bootstrap that materializes the object before cells run. A fixture that pins
an unmaterializable SHA without bootstrap SHALL be rejected by fixture integrity preflight (see
`eval-fixture-preflight`), not accepted as a runnable graded task.

#### Scenario: Full SHA that is present remains valid under the corpus policy

- **WHEN** a fixture declares a full 40-character `base_commit` that exists as a commit object in
  the evaluation clone
- **THEN** the corpus policy SHALL treat the fixture as object-reachable for integrity preflight

#### Scenario: Full SHA without object and without bootstrap is not runnable

- **WHEN** a fixture declares a well-formed full SHA that is absent from the clone and declares no
  bootstrap
- **THEN** integrity preflight SHALL treat the fixture as non-runnable
- **AND** SHALL name the fixture and the SHA

---

### Requirement: Smoke-only fixtures SHALL NOT be treated as graded quality measurements

A fixture marked smoke-only SHALL be eligible for harness path and isolation smoke execution, but
SHALL NOT be included in graded comparative quality aggregates that require grader outputs. An
experiment that requests graded reporting for a smoke-only fixture SHALL be rejected at validation
or SHALL record only infrastructure/smoke outcomes without producing a quality grade for that
fixture.

#### Scenario: Smoke-only fixture is excluded from graded aggregates

- **WHEN** reporting aggregates graded quality across an experiment that included smoke-only
  fixtures
- **THEN** those smoke-only fixtures' cells SHALL NOT contribute graded quality scores
- **AND** their presence SHALL remain distinguishable as smoke

#### Scenario: Experiment demanding grades for smoke-only fixtures is rejected or ungraded

- **WHEN** an experiment configuration requires graded output for a fixture marked smoke-only
- **THEN** validation or grading SHALL refuse to emit a quality grade for that fixture
- **AND** SHALL name the fixture and the smoke-only mark
