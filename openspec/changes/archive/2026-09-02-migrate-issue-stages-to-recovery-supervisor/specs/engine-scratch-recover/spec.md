## ADDED Requirements

### Requirement: Unknown dirt SHALL be preserved or quarantined and never deleted

When worktree porcelain includes paths that are not in the engine-known non-product scratch set, the shared materialization and scratch-recovery paths SHALL preserve those paths or quarantine them so lookup cannot treat the tree as a clean present worktree. The pipeline SHALL report unknown or unclassified dirt as inconsistency. The pipeline SHALL NOT delete unknown work. Pipeline-owned scratch MAY still be unlinked or restored as specified by the existing scratch-only recovery requirement. Known product dirt SHALL still fail closed.

#### Scenario: Unclassified porcelain is not deleted

- **WHEN** porcelain includes an untracked path that is not in `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` (or the equivalent shared classifier set)
- **THEN** materialization and scratch recovery SHALL NOT unlink, `git clean`, or otherwise delete that path
- **AND** SHALL emit an inconsistency observation
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Quarantine does not destroy unknown work

- **WHEN** materialization cannot proceed because of unknown dirt
- **THEN** the seam MAY refuse reuse or quarantine the path so later lookup does not classify it as a clean present worktree
- **AND** the unknown files SHALL still exist after the refusal
- **AND** the adapter SHALL NOT treat the refusal as a reason to delete the tree

#### Scenario: Scratch-only dirt still unlinks

- **WHEN** porcelain lists only engine-known scratch paths
- **THEN** the existing `unlink_engine_scratch` treatment MAY remove or restore those scratch paths
- **AND** SHALL NOT delete any non-scratch path
