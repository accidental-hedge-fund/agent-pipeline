## ADDED Requirements

### Requirement: Multi-change grading SHALL evaluate new and inherited held-out verifiers per checkpoint

When grading a multi-change cell, the grading layer SHALL, for each checkpoint k in order, run that checkpoint's held-out verifiers and every held-out verifier declared by checkpoints 1..k-1. Grading SHALL treat verifier execution as deterministic and SHALL NOT expose verifier definitions to the treatment under grade. Single-task grading behavior for non-multi-change fixtures SHALL remain unchanged.

#### Scenario: Inherited verifiers are re-run

- **WHEN** a multi-change cell is graded at checkpoint C2
- **THEN** the grade for C2 SHALL include results for C2's new verifiers and for C1's held-out verifiers

#### Scenario: Single-task fixtures are unaffected

- **WHEN** a single-task fixture cell is graded
- **THEN** grading SHALL use the existing single-task grader path without requiring checkpoint inheritance logic

---

### Requirement: Multi-change grades SHALL record strict pass and defect-state fields

For each graded checkpoint the grade record SHALL include a strict-pass boolean that is true only when all new and all inherited verifiers pass. The grade record SHALL also include current-step defect identifiers, inherited defect identifiers, accumulated unresolved defect identifiers through that checkpoint, and recovered defect identifiers relative to earlier checkpoints in the same lineage. After the final checkpoint the grade or lineage summary SHALL state whether the lineage is terminal all-green.

#### Scenario: Strict pass false on inherited failure

- **WHEN** all new verifiers at Ck pass and at least one inherited verifier fails
- **THEN** strict pass for Ck SHALL be false
- **AND** the failing verifier's identifier SHALL appear in inherited defects

#### Scenario: Recovery is recorded

- **WHEN** a verifier failed at C1 and passes at C2
- **THEN** C2's recovered defects SHALL include that verifier's identifier
- **AND** it SHALL NOT remain in C2's accumulated unresolved set

#### Scenario: Terminal all-green requires full closure

- **WHEN** the final checkpoint is graded
- **THEN** terminal all-green SHALL be true only if every held-out verifier declared anywhere in the fixture sequence passes at the final state

---

### Requirement: Multi-change grading SHALL continue lineage accounting when intermediate strict pass fails

When an intermediate checkpoint is not a strict pass, grading SHALL still produce grade records for later checkpoints in the same cell when those steps executed. Grading SHALL NOT discard later checkpoint grades solely because an earlier checkpoint failed strict pass.

#### Scenario: Later grades exist after early fail

- **WHEN** C1 strict pass is false and C2 executed and is graded
- **THEN** grades.jsonl (or equivalent) SHALL contain grade records for both C1 and C2
