## ADDED Requirements

### Requirement: Engine-promote deployment SHALL prove the authorized candidate digest is live

A successful `pipeline engine-promote` deployment SHALL prove the authorized published-artifact digest is the live installed engine for the selected host set. The path SHALL observe pin identity and live install identity through injectable seams. An installer exit code or an installed version string that matches `X.Y.Z` SHALL NOT complete deployment when the live digest differs from the authorized candidate.

#### Scenario: Matching version with wrong digest does not complete

- **WHEN** promote installs tag `v1.39.3`
- **AND** `pipeline --version` reports `1.39.3`
- **AND** the live digest does not equal the authorized published artifact digest
- **THEN** engine-promote SHALL NOT report verified deployment success
- **AND** RecoverySupervisor SHALL keep the deployment operation owned

#### Scenario: Matching digest completes deployment

- **WHEN** the observer proves the live installed engine digest equals the authorized published artifact
- **AND** the production pin names that same identity
- **THEN** engine-promote MAY report verified deployment success

---

### Requirement: Deployment SHALL bind install to a pin-generation compare-and-swap

When ship deployment installs, `runEnginePromote` SHALL verify the expected pin generation immediately before mutation. If the live pin identity no longer matches that claim, the path SHALL fail without installing and SHALL NOT rewrite the pin to restore the prior target. After mutation the same generation-bound claim SHALL be reconciled again.

#### Scenario: Retarget after preflight refuses install

- **WHEN** deployment has observed an authorized pin generation
- **AND** another actor retargets the production pin before install
- **THEN** engine-promote SHALL fail without installing
- **AND** it SHALL NOT promote the pin back to the stale authorized digest

---

### Requirement: Engine-promote SHALL NOT grant rollback from generic install or verify failure

When install or live-identity verify fails after a pin mutation, `pipeline engine-promote` SHALL report a typed observation with side-effect certainty and SHALL NOT call pin rollback. Automatic rollback SHALL require the separate protected rollback operation with an authenticated envelope naming that rollback and the retained target. Operator `pipeline factory-pin rollback` remains the authorized rollback surface.

#### Scenario: Install failure leaves the pin for reconciliation

- **WHEN** pin promotion succeeded
- **AND** install from the new tag fails
- **AND** no authenticated rollback envelope is present
- **THEN** engine-promote SHALL NOT roll the pin back
- **AND** it SHALL NOT reinstall the previous tag as a side effect
- **AND** the result SHALL remain a owned deployment failure, not a completed rollback

#### Scenario: Verify failure also grants no rollback

- **WHEN** install ran
- **AND** live identity does not match the authorized digest
- **AND** no authenticated rollback envelope is present
- **THEN** engine-promote SHALL NOT roll the pin back
- **AND** RecoverySupervisor SHALL keep deployment owned
