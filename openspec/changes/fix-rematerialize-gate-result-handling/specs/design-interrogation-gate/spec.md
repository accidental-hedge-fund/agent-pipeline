## ADDED Requirements

### Requirement: Design-gate SHALL continue from successful rematerialize result variants

When design-gate is triggered and the issue's managed worktree is not on disk, the stage SHALL invoke `ensureManagedWorktree` before parking for absence. On `result: "pass"` or `result: "skipped"` with a non-null worktree, design-gate SHALL continue decision-record / challenge work from the returned path and SHALL NOT call `setBlocked` solely for that rematerialize outcome. On `result: "fail"`, design-gate SHALL park with the seam's typed `blockerKind` and a reason that names the rematerialize failure without interpolating `undefined` as the kind. Design-gate SHALL NOT require a nonexistent success token such as `"ok"`.

#### Scenario: Pass rematerialize advances design-gate without false worktree-missing park

- **WHEN** design-gate is triggered for an issue
- **AND** on-disk worktree lookup returns no worktree
- **AND** `ensureManagedWorktree` returns `{ result: "pass", worktree: { path, slug, branch }, reason }` describing a successful recreate
- **AND** decision-record and challenge harness results allow approval
- **THEN** design-gate SHALL continue from `worktree.path`
- **AND** SHALL NOT `setBlocked` for rematerialize success
- **AND** on clean approval SHALL advance toward `review-1` (or the stage's normal next step)

#### Scenario: Skipped rematerialize with path continues design-gate

- **WHEN** design-gate on-disk lookup returns no worktree
- **AND** `ensureManagedWorktree` returns `{ result: "skipped", worktree: { path, slug }, reason }`
- **THEN** design-gate SHALL continue from the returned path
- **AND** SHALL NOT park solely because the result was `skipped`

#### Scenario: Fail rematerialize parks with typed kind

- **WHEN** design-gate on-disk lookup returns no worktree
- **AND** `ensureManagedWorktree` returns `{ result: "fail", worktree: null, blockerKind, reason }`
- **THEN** design-gate SHALL `setBlocked` with that `blockerKind`
- **AND** the reason SHALL include the typed kind and rematerialize failure text
- **AND** the reason SHALL NOT contain `failed (undefined)`
