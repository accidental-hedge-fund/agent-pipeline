## ADDED Requirements

### Requirement: A fixture SHALL be able to declare hidden checks that are never exposed to a treatment

The fixture contract SHALL admit an optional set of **hidden checks** — deterministic checks
resolvable only by the grading layer. Hidden checks SHALL NOT appear in any input, artifact, or prompt supplied to a treatment, and SHALL
be disjoint from the fixture's public checks. A fixture that declares the same check as both public
and hidden SHALL be rejected, naming the fixture and the offending check.

A fixture that declares no hidden checks SHALL remain valid.

#### Scenario: Hidden checks are absent from treatment inputs

- **WHEN** a cell is executed for a fixture declaring hidden checks
- **THEN** no input, stage-entry artifact, or materialized prompt supplied to the treatment SHALL
  contain any hidden check

#### Scenario: A check declared both public and hidden is rejected

- **WHEN** a fixture declares the same check in both its public checks and its hidden checks
- **THEN** fixture validation SHALL fail naming the fixture and that check

#### Scenario: Hidden checks are optional

- **WHEN** a fixture declaring no hidden checks is loaded
- **THEN** validation SHALL succeed

---

### Requirement: A review fixture SHALL be able to declare seeded-defect ground truth

The fixture contract SHALL admit an optional set of **seeded defects** serving as ground truth for
review grading. Each seeded defect SHALL declare a stable `defect_id` unique within the fixture, a location consisting of a repository
path and a line range, and an `expected_severity`. A fixture declaring a seeded defect with a
duplicate `defect_id`, a missing location, or a missing `expected_severity` SHALL be rejected naming
the fixture and the offending defect.

#### Scenario: A complete seeded defect is accepted

- **WHEN** a fixture declares a seeded defect with a unique `defect_id`, a path and line range, and
  an `expected_severity`
- **THEN** validation SHALL succeed
- **AND** the defect SHALL be exposed to the grading layer as review ground truth

#### Scenario: A duplicate defect identifier is rejected

- **WHEN** a fixture declares two seeded defects with the same `defect_id`
- **THEN** validation SHALL fail naming the fixture and the duplicated `defect_id`

#### Scenario: An incomplete seeded defect is rejected

- **WHEN** a seeded defect omits its location or its `expected_severity`
- **THEN** validation SHALL fail naming the fixture, the `defect_id`, and the missing field

---

### Requirement: A fixture SHALL be able to declare acceptance criteria and an allowed-change boundary

The fixture contract SHALL admit optional **acceptance criteria** — individually identified,
checkable statements a correct result must satisfy — and an optional **allowed-change boundary**
listing the repository paths a correct result may modify. When an allowed-change boundary is declared, the
grading layer SHALL treat every changed path outside it as out of scope; when none is declared, the
out-of-scope measurement SHALL be reported as unknown rather than as zero.

#### Scenario: Acceptance criteria are exposed to grading

- **WHEN** a fixture declaring acceptance criteria is loaded
- **THEN** each criterion SHALL carry a stable identifier
- **AND** the criteria SHALL be exposed to the grading layer

#### Scenario: An allowed-change boundary defines out-of-scope changes

- **WHEN** a fixture declares an allowed-change boundary
- **THEN** the grading layer SHALL classify a changed path not covered by that boundary as an
  out-of-scope change

#### Scenario: Absent boundary yields unknown rather than zero

- **WHEN** a fixture declares no allowed-change boundary
- **THEN** the out-of-scope change measurement for cells of that fixture SHALL be reported as
  unknown
- **AND** SHALL NOT be reported as zero

---

### Requirement: A fixture SHALL declare version identifiers for the graders that apply to it

A fixture's grader references SHALL carry a version identifier for each referenced grader, so that a
grade can state which grader version produced it. A fixture referencing a grader whose version the
grading layer does not support SHALL be rejected naming the fixture, the grader, and the unsupported
version, rather than being graded on a best-effort basis.

#### Scenario: Grader references carry versions

- **WHEN** a fixture's grader references are read
- **THEN** each reference SHALL name a grader and a grader version

#### Scenario: An unsupported grader version is rejected

- **WHEN** a fixture references a grader version the grading layer does not support
- **THEN** validation SHALL fail naming the fixture, the grader, and the unsupported version
- **AND** the grading layer SHALL NOT grade that fixture's cells on a best-effort basis
