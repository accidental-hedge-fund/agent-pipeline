# eval-graders Specification

## Purpose
TBD - created by archiving change eval-graders-and-comparative-reporting. Update Purpose after archive.
## Requirements
### Requirement: Grading SHALL be an additive pass that never modifies the source run artifacts

The grading layer SHALL read a completed experiment's resolved manifest, run plan, completed-cell
record stream, failed-cell record stream, and referenced fixtures, and SHALL write its output as new
files in the same experiment output directory. It SHALL NOT modify, rewrite, truncate, or delete any
file written by the experiment runner.

Grading SHALL be deterministic: grading the same records and fixtures with the same grader versions
twice SHALL produce byte-identical output.

#### Scenario: Source artifacts are unchanged by grading

- **WHEN** grading runs over a completed experiment
- **THEN** the resolved manifest, run plan, completed-cell stream, and failed-cell stream SHALL be
  byte-identical to their contents before grading

#### Scenario: Grading emits a grade stream and a summary

- **WHEN** grading completes for an experiment
- **THEN** the experiment output directory SHALL contain a `grades.jsonl` record stream with one
  independently parseable JSON object per graded cell
- **AND** SHALL contain a `summary.json` aggregate report

#### Scenario: Grading is deterministic

- **WHEN** grading is run twice over the same records, fixtures, and grader versions
- **THEN** the two `grades.jsonl` outputs SHALL be byte-identical
- **AND** the two `summary.json` outputs SHALL be byte-identical

#### Scenario: Grades do not participate in the pipeline state machine

- **WHEN** grading produces any grade or summary
- **THEN** no pipeline stage label, review verdict, gate result, or merge decision SHALL depend on
  it

---

### Requirement: Every grade record SHALL carry the identity needed to join it to its cell and its graders

Each grade record SHALL carry the graded cell's `cell_id`, `experiment_id`, `fixture_id`,
`treatment_id`, and `replicate`, together with the identifier and version of every grader that
contributed to it. A grade whose grader versions are not recorded SHALL NOT be written.

#### Scenario: Grade records carry cell identity

- **WHEN** a grade record is read
- **THEN** it SHALL contain `cell_id`, `experiment_id`, `fixture_id`, `treatment_id`, and
  `replicate`

#### Scenario: Grade records carry grader versions

- **WHEN** a grade record is read
- **THEN** it SHALL name each contributing grader and that grader's version

---

### Requirement: Implementation and fix cells SHALL be graded on hidden tests, acceptance criteria, regressions, and out-of-scope changes

For a cell produced by an implementing or fix stage, the grading layer SHALL report a hidden-test
pass rate over the fixture's hidden checks, an acceptance-criterion completion figure over the
fixture's acceptance criteria, a regression count, and an out-of-scope change count.

A **regression** SHALL be a check that passes at the fixture's `base_commit` and fails on the
candidate result. A check that fails at both the base commit and on the candidate result SHALL be
reported as a pre-existing failure and SHALL NOT be counted as a regression. An **out-of-scope
change** SHALL be a changed repository path not covered by the fixture's allowed-change boundary;
when the fixture declares no boundary the count SHALL be reported as unknown.

#### Scenario: Hidden-test pass rate is reported

- **WHEN** an implementing or fix cell is graded against a fixture declaring hidden checks
- **THEN** the grade SHALL report the number of hidden checks that passed and the number executed

#### Scenario: A pre-existing failure is not a regression

- **WHEN** a hidden check fails both at the fixture's `base_commit` and on the candidate result
- **THEN** the grade SHALL report it as a pre-existing failure
- **AND** SHALL NOT count it in the regression count

#### Scenario: A newly failing check is a regression

- **WHEN** a check passes at the fixture's `base_commit` and fails on the candidate result
- **THEN** the grade SHALL count it as a regression

#### Scenario: Changes outside the boundary are counted as out of scope

- **WHEN** a candidate result modifies a path not covered by the fixture's allowed-change boundary
- **THEN** the grade SHALL count that path in the out-of-scope change count

#### Scenario: Acceptance-criterion completion is reported per criterion

- **WHEN** a cell is graded against a fixture declaring acceptance criteria
- **THEN** the grade SHALL report, for each criterion identifier, whether it was satisfied
- **AND** SHALL report the completed count and the total

---

### Requirement: Review cells SHALL be graded against seeded-defect ground truth

For a cell produced by a review stage, the grading layer SHALL match the reported findings against
the fixture's seeded defects and report precision, recall, F1, a severity-calibration distribution,
and a false-positive count.

A finding SHALL match a seeded defect when it names the defect's path and overlaps the defect's line
range. A matched defect SHALL be a true positive, an unmatched defect a false negative, and an
unmatched finding a false positive. Severity calibration SHALL be reported as the distribution of
signed differences between reported and expected severity over matched defects, and SHALL NOT be
collapsed into a single accuracy value. Matching SHALL be deterministic and SHALL NOT invoke a model.

#### Scenario: Precision, recall, and F1 are computed from matches

- **WHEN** a review cell's findings are matched against the fixture's seeded defects
- **THEN** the grade SHALL report precision, recall, and F1 derived from the true-positive,
  false-positive, and false-negative counts

#### Scenario: An unmatched finding is a false positive

- **WHEN** a reported finding matches no seeded defect
- **THEN** it SHALL be counted as a false positive

#### Scenario: A missed defect is a false negative

- **WHEN** a seeded defect is matched by no reported finding
- **THEN** it SHALL be counted as a false negative

#### Scenario: Severity calibration preserves direction

- **WHEN** matched findings include both over-called and under-called severities
- **THEN** the grade SHALL report the signed severity differences as a distribution
- **AND** over-calls and under-calls SHALL NOT cancel into a single value

#### Scenario: Matching invokes no model

- **WHEN** review grading matches findings to defects
- **THEN** no model call SHALL be made as part of the match

---

### Requirement: Planning cells SHALL be graded against a versioned rubric that never consumes a treatment self-score

For a cell produced by a planning stage, the grading layer SHALL score requirement coverage,
unsupported assumptions, actionability, and downstream compatibility under a named rubric, and SHALL
record the `rubric_version` used in the grade record.

A self-assessment, self-score, or confidence value emitted by the treatment under test SHALL NOT be
used as an input to any planning grade. Such a value MAY be recorded as a separate observation on the
cell.

#### Scenario: Planning grade reports all four rubric dimensions

- **WHEN** a planning cell is graded
- **THEN** the grade SHALL report requirement coverage, unsupported assumptions, actionability, and
  downstream compatibility

#### Scenario: The rubric version is recorded

- **WHEN** a planning grade is written
- **THEN** it SHALL name the rubric and its `rubric_version`

#### Scenario: A treatment self-score is not ground truth

- **WHEN** a planning cell's output contains a self-assessment or self-score
- **THEN** the planning grade SHALL be identical to the grade produced when that self-assessment is
  absent
- **AND** the self-assessment MAY be recorded as an observation distinct from the grade

---

### Requirement: Model-judge results SHALL be recorded separately from deterministic grades and SHALL NOT alter them

Model judging SHALL be optional. When it runs, each judge result SHALL be written as its own record
carrying the judged `cell_id`, the judge harness, the judge model, and the judge prompt version,
together with the judge's verdict.

A judge result SHALL NOT be an input to any deterministic grade field. The deterministic grade fields
for a cell SHALL be identical whether or not judging ran.

#### Scenario: Judge results carry judge identity

- **WHEN** a judge result is read
- **THEN** it SHALL name the judge harness, the judge model, and the judge prompt version

#### Scenario: Judging does not move a deterministic grade

- **WHEN** the same experiment is graded with judging enabled and with judging disabled
- **THEN** every deterministic grade field SHALL be identical between the two runs

#### Scenario: Judging is optional

- **WHEN** grading runs with judging disabled
- **THEN** grading SHALL complete and produce deterministic grades
- **AND** no judge record SHALL be written

#### Scenario: Judge and deterministic disagreement is surfaced

- **WHEN** a judge verdict contradicts the deterministic grade for the same cell
- **THEN** the disagreement SHALL be recorded as such
- **AND** the deterministic grade SHALL be unchanged

---

### Requirement: The system SHALL support blinded human adjudication records for judge and test disagreements

The grading layer SHALL support attaching a human adjudication record to a recorded disagreement.
The material presented for adjudication SHALL identify the cell by an opaque key derived from its
`cell_id` and SHALL NOT disclose the cell's harness, provider, model, or effort. An adjudication
record SHALL store the opaque key, the adjudicated verdict, and a rationale, and SHALL be joinable
back to its cell by that key.

#### Scenario: Adjudication material is blinded

- **WHEN** a disagreement is presented for human adjudication
- **THEN** the presented material SHALL identify the cell only by an opaque key
- **AND** SHALL NOT contain the cell's harness, provider, model, or effort

#### Scenario: An adjudication record joins back to its cell

- **WHEN** an adjudication record is stored
- **THEN** it SHALL contain the opaque key, the verdict, and a rationale
- **AND** the key SHALL resolve to exactly one cell at aggregation time

#### Scenario: Adjudication does not rewrite the deterministic grade

- **WHEN** a human adjudication record is added for a cell
- **THEN** the cell's deterministic grade record SHALL be unchanged
- **AND** the adjudication SHALL be reported as a distinct record

---

### Requirement: Cells that did not complete SHALL NOT be graded as treatment quality

The grading layer SHALL grade only cells whose `result_class` is `completed`. A cell recorded as
`infra_error`, `auth_error`, or `timeout` SHALL NOT contribute to any quality metric and SHALL NOT
be assigned a substitute or zero score. Such cells SHALL be carried into reporting as reliability
counts only.

#### Scenario: A failed cell is not assigned a score

- **WHEN** a cell is recorded with `result_class` `infra_error`, `auth_error`, or `timeout`
- **THEN** no quality grade SHALL be written for it
- **AND** it SHALL NOT be counted as a zero score

#### Scenario: A completed-but-poor cell is graded

- **WHEN** a cell is recorded with `result_class` `completed` and the treatment performed badly
- **THEN** it SHALL be graded normally and its low scores SHALL contribute to quality metrics

---

### Requirement: Grading SHALL be exercised by checked-in synthetic fixtures with no live model call

The repository SHALL contain a small synthetic fixture set and recorded cell records sufficient to
exercise implementation/fix grading, review grading, planning grading, judge separation, failure-class
exclusion, and aggregation. The tests over them SHALL make no live model call, network request, real
git operation, or subprocess spawn, and SHALL pass with no provider credential configured.

#### Scenario: Synthetic fixtures exercise every grader

- **WHEN** the test suite runs
- **THEN** implementation/fix grading, review grading, planning grading, judge separation, and
  failure-class exclusion SHALL each be exercised against checked-in synthetic inputs

#### Scenario: Continuous integration needs no credentials

- **WHEN** the continuous-integration gate runs the grading tests
- **THEN** no live model call, network request, real git operation, or subprocess spawn SHALL occur
- **AND** the tests SHALL pass with no provider credential configured

### Requirement: Deterministic implementation grading SHALL apply to completed paired-cell outcomes

The grading layer SHALL apply deterministic implementation grading to completed paired-cell
outcomes. When a cell produced by `implementing-paired` or `pipeline-paired` mode completes
as a treatment outcome (`result_class` `completed`), the grading layer SHALL apply the same
deterministic implementation grader family used for single-role implementing/fix cells to
the cell's **final** worktree state (after the last fix round if any fix ran, otherwise after
implementation). The grade record SHALL carry the cell's pair `treatment_id` and identity
keys so it joins to the paired cell and to comparative reports.

Paired cells that did not complete (`infra_error`, `auth_error`, `timeout`) SHALL NOT be
graded as treatment quality, matching the existing non-completed rule.

#### Scenario: Final post-fix tree is graded

- **WHEN** an `implementing-paired` cell completes after a fix-and-re-review path
- **THEN** the implementation grader SHALL evaluate the post-fix worktree state
- **AND** SHALL report hidden-test, acceptance-criterion, regression, and out-of-scope
  metrics for that state

#### Scenario: No-fix paired cell is graded on the implementation tree

- **WHEN** an `implementing-paired` cell completes with no fix invoked
- **THEN** the implementation grader SHALL evaluate the post-implementation worktree state

#### Scenario: Timed-out paired cell is not quality-graded

- **WHEN** a paired cell is recorded as `timeout`
- **THEN** the grading layer SHALL NOT write a treatment quality grade for that cell

#### Scenario: Grade joins on pair treatment id

- **WHEN** a grade record for a paired cell is read
- **THEN** its `treatment_id` SHALL equal the pair's declared id
- **AND** SHALL match the corresponding cell record's `treatment_id`

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

