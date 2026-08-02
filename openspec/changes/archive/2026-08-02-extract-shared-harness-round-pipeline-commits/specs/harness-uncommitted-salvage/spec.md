## ADDED Requirements

### Requirement: Migrated implementer stages SHALL reach salvage via the shared harness-round helper

When fix-round, planning implement, visual-fix, eval-fix, or pre-merge bounded auto-fix is migrated to the shared harness-round helper, those call sites SHALL still invoke the existing salvage implementation (`trySalvageUncommittedWork` / `salvageUncommittedWork`) on the dirty no-new-commit paths required by this capability. The shared helper SHALL NOT replace, fork, or weaken salvage staging rules (depth-agnostic `node_modules` exclusion, pipeline-internal marker exclusion, optional `openspec/` scope, salvage subject/trailers, failure-reason disclosure).

#### Scenario: Shared-round dirty path still salvages with existing helper

- **WHEN** a migrated consumer exits with no new commit and a dirty salvageable worktree
- **THEN** the shared harness-round path SHALL call the existing salvage helper
- **AND** the resulting salvage commit SHALL satisfy the same subject, trailer, and exclusion rules as before the extraction

#### Scenario: Salvage semantics regression nets still bite after migration

- **WHEN** existing salvage unit tests (marker-only clean, nested node_modules exclusion, scoped authoring, failure-reason disclosure) run after stages are wired through the shared helper
- **THEN** those tests SHALL continue to fail without their protections and pass with them
- **AND** migration SHALL NOT delete or disable those nets without equivalent replacements
