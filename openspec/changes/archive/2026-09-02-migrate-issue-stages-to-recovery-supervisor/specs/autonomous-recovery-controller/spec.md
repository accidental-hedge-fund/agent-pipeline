## ADDED Requirements

### Requirement: auto_recover SHALL be a RecoverySupervisor compatibility adapter

`auto_recover` SHALL claim or resume the Recovery Episode of the owning Logical Operation. It SHALL report a typed operation observation. It SHALL NOT own an independent retry budget, comment-counted cap, or terminal outcome. `auto_recovery_max_retries` SHALL NOT permanently block an issue or end RecoverySupervisor ownership. Worktree removal and reset-to-ready MAY remain RecoverySupervisor treatments when the candidate has no commits ahead and dirt is pipeline-owned scratch. They SHALL NOT run as a second controller. RecoverySupervisor SHALL remain the sole lifecycle owner. Recipe selection named by this capability SHALL be RecoverySupervisor treatment, not a separate controller.

#### Scenario: Independent auto-recovery cap cannot terminalize

- **WHEN** implementation produced no commits ahead of base
- **AND** prior auto-recovery comments equal `auto_recovery_max_retries`
- **THEN** `auto_recover` SHALL emit an observation
- **AND** SHALL NOT post a terminal auto-recovery-limit outcome that ends ownership
- **AND** RecoverySupervisor SHALL retain the Logical Operation as Cooling or another owned treatment

#### Scenario: auto_recover claims the same episode

- **WHEN** advance invokes `auto_recover` for issue `N`
- **THEN** it SHALL claim or resume the Recovery Episode for that issue's Logical Operation
- **AND** SHALL NOT mint a second independent recovery identity

#### Scenario: Scratch-only no-commit recovery remains a treatment

- **WHEN** RecoverySupervisor selects a reset-to-ready treatment
- **AND** porcelain is pipeline-owned scratch only
- **AND** no commits exist ahead of base
- **THEN** the compatibility adapter MAY remove the managed worktree and return the issue to `pipeline:ready` as that treatment
- **AND** the Logical Operation SHALL remain owned
