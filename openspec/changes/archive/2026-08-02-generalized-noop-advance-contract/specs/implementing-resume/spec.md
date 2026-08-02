## ADDED Requirements

### Requirement: Implementing re-entry SHALL adopt an existing planning deliverable when the implement goal is already satisfied

When the pipeline re-enters the implementing stage or the implement phase of planning (including a **fresh process** re-entry, not only an in-memory helper call) and the accepted planning deliverable is already present at HEAD — for example a spec-only issue whose OpenSpec change under `openspec/changes/<id>/` landed in the planning commit — the path SHALL evaluate implement goal satisfaction via the shared `noop-advance-contract` (implement-deliverable-present). When the check reports satisfied, the worktree is clean relative to the implement headBefore, and relevant gates for the path are green, the pipeline SHALL advance through post-implement steps (test gate → push → open-or-find PR → transition toward review as already specified) **without** requiring an empty implementer commit and **without** blocking with `blockerKind: "no-commits"` solely for an empty implementer commit range. When the deliverable is missing or gates fail, the path SHALL fail closed (restart, block, or re-invoke implement per existing rules) and SHALL NOT skip implement solely because a prior harness “succeeded” with no commits.

#### Scenario: Spec-only planning commit deliverable advances without empty implement commit

- **WHEN** a fresh re-entry reaches implementing / implement with the accepted OpenSpec deliverable already present from the planning commit
- **AND** the implement harness produces no new commit (or is skipped because goal is already satisfied)
- **AND** the worktree is clean and relevant gates pass
- **THEN** the pipeline SHALL advance without inventing an empty commit
- **AND** SHALL NOT set `blockerKind: "no-commits"` solely for the empty implementer range
- **AND** SHALL record attested goal-satisfaction evidence at the evaluated HEAD SHA

#### Scenario: Missing deliverable still fails closed

- **WHEN** implementing / implement ends with no new commit and the declared OpenSpec or freeform deliverable is absent at HEAD
- **THEN** the shared evaluation SHALL not report implement-deliverable-present satisfaction
- **AND** the path SHALL block or recover under existing no-commits / crash-stranded rules rather than advancing as complete
