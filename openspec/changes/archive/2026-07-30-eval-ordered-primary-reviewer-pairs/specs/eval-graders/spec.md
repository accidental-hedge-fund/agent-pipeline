## ADDED Requirements

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
