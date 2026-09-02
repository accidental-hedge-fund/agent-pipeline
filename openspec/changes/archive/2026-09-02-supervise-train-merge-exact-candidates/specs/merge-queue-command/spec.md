## ADDED Requirements

### Requirement: Merge-queue apply SHALL share merge invariant reconciliation and recovery episodes

When merge-queue runs with `--apply` (and without `--dry-run`), each candidate merge SHALL use the shared merge operation invariant, exact-candidate claim, and RecoverySupervisor recovery episodes used by `pipeline merge`. Merge-queue SHALL reconcile remote PR state and base containment before retrying a candidate. Dry-run SHALL remain the default and SHALL perform no merges, claims, or recovery side effects.

#### Scenario: Apply uses the shared merge invariant

- **WHEN** the operator runs `pipeline merge-queue --milestone "v1.40.1" --apply`
- **THEN** each candidate merge SHALL use the same gates, claim binding, and replay rule as `pipeline merge`
- **AND** an uncertain merge response SHALL remain a RecoverySupervisor-owned episode

#### Scenario: Dry-run remains the default

- **WHEN** the operator runs `pipeline merge-queue --milestone "v1.40.1"`
- **THEN** the handler SHALL run in dry-run mode
- **AND** SHALL NOT persist a merge claim
- **AND** SHALL NOT call any merge primitive

#### Scenario: Apply crash reconciles before replay

- **WHEN** apply dies after submitting merge for candidate A
- **THEN** a later apply SHALL observe whether A is merged and contained
- **AND** it SHALL NOT submit a second merge for A when that postcondition is proven
- **AND** it SHALL continue remaining candidates
