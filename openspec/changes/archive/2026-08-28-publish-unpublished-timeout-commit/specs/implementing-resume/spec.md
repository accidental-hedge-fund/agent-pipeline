## ADDED Requirements

### Requirement: Same-process implementing timeout SHALL resume post-implementation when the unpublished commit is publishable

When the implementing harness returns timeout (or equivalent failure) in the same process that still owns the managed worktree, and `unpublished-stage-commit-publish` classifies HEAD as a publishable unpublished stage commit with a satisfied implement deliverable, the engine SHALL take the existing post-implementation path — format and test gates → push → create-or-find PR → transition `implementing → review-1` — without waiting for a later launcher, `recover-parked`, or an operator unblock. This path SHALL be the same post-implementation sequence used on re-entry when commits exist ahead of base. A live concurrent owner of the planning marker SHALL still return `waiting` and SHALL NOT publish.

#### Scenario: Same-process timeout with checkpoint commit publishes

- **WHEN** implementing times out in the process that still holds the worktree
- **AND** a salvage or ownership-checkpoint commit is publishable unpublished
- **AND** the implement deliverable is satisfied
- **AND** no live process other than this one owns the planning marker
- **THEN** the engine SHALL run format and test gates, push, create or find the PR, and transition to `review-1`
- **AND** SHALL NOT return a blocked timeout outcome that leaves the commit unpublished

#### Scenario: Same-process timeout with a pipeline-authored implement tip publishes

- **WHEN** implementing times out in the process that still holds the worktree
- **AND** HEAD is a pipeline-authored implement commit (issue trailers present)
- **AND** the classifier reports a publishable unpublished stage commit
- **AND** this-round `salvaged` and `ownershipCheckpointed` are both false
- **THEN** the engine SHALL take the post-implementation publish path
- **AND** SHALL NOT require a legacy salvage or ownership-checkpoint flag to select publication

#### Scenario: Re-entry after a prior timeout park still publishes

- **WHEN** a prior run parked at `implementing` after timeout with a retained worktree holding the unpublished commit
- **AND** a later `recover-parked` or whole-item re-entry reaches implementing-resume
- **AND** the classifier still matches
- **THEN** the engine SHALL take the same post-implementation path
- **AND** SHALL NOT roll back to `ready` as crash-stranded solely because no PR exists yet
