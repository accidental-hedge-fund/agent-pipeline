## ADDED Requirements

### Requirement: Post-implement PR create-or-reuse SHALL invoke supersession of other open issue PRs

When the shared post-implementation path (`resumeFromImplementing` or equivalent) has successfully created or exact-head-reused the managed PR for the current managed branch of issue N, it SHALL invoke the supersede-stale-issue-prs sweep for issue N with that managed PR number and managed head branch before completing the stage transition away from `implementing`. The path SHALL continue to use exact-head matching (`getPrForBranch` or equivalent) for create-or-reuse of the managed PR and SHALL NOT switch managed-PR selection back to “first dual-strategy match only” in a way that reuses a different-head open PR as the live managed PR.

#### Scenario: first open runs supersession after createPr

- **WHEN** the post-implement path creates a new managed PR for the managed head
- **THEN** it SHALL run the supersession sweep for that issue and managed PR
- **AND** SHALL still transition toward design-gate/review using the managed PR number

#### Scenario: resume reuse runs supersession after exact-head match

- **WHEN** the post-implement path reuses an existing PR for the managed head via exact-head match
- **THEN** it SHALL run the supersession sweep for that issue and managed PR
- **AND** SHALL NOT treat a different-head open issue-linked PR as the managed PR solely because dual-strategy resolution would prefer it
