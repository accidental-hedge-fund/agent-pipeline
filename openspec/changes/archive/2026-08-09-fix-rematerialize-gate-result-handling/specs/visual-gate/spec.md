## ADDED Requirements

### Requirement: Visual-gate SHALL continue from successful rematerialize result variants

When `visual_gate.enabled` is true and the issue's managed worktree is not on disk, visual-gate SHALL invoke `ensureManagedWorktree` before parking for absence. On `result: "pass"` or `result: "skipped"` with a non-null worktree, visual-gate SHALL run `visual_gate.command` (and subsequent visual-gate logic) with the returned path as the working directory and SHALL NOT call `setBlocked` solely for that rematerialize outcome. On `result: "fail"`, visual-gate SHALL park with the seam's typed `blockerKind` and a reason that names the rematerialize failure without interpolating `undefined` as the kind. Visual-gate SHALL NOT require a nonexistent success token such as `"ok"`.

#### Scenario: Pass rematerialize supplies path to visual runner

- **WHEN** the current stage is `visual-gate` and `cfg.visual_gate.enabled` is `true`
- **AND** on-disk worktree lookup returns no worktree
- **AND** `ensureManagedWorktree` returns `{ result: "pass", worktree: { path, slug, branch }, reason }`
- **THEN** visual-gate SHALL execute the visual command with that `path` as the working directory
- **AND** SHALL NOT `setBlocked` solely for rematerialize success

#### Scenario: Skipped rematerialize with path continues visual-gate

- **WHEN** visual-gate on-disk lookup returns no worktree
- **AND** `ensureManagedWorktree` returns `{ result: "skipped", worktree: { path, slug }, reason }`
- **THEN** visual-gate SHALL continue using the returned path
- **AND** SHALL NOT park solely because the result was `skipped`

#### Scenario: Fail rematerialize parks with typed kind

- **WHEN** visual-gate on-disk lookup returns no worktree
- **AND** `ensureManagedWorktree` returns `{ result: "fail", worktree: null, blockerKind, reason }`
- **THEN** visual-gate SHALL `setBlocked` with that `blockerKind`
- **AND** the reason SHALL include the typed kind and rematerialize failure text
- **AND** the reason SHALL NOT contain `failed (undefined)`
