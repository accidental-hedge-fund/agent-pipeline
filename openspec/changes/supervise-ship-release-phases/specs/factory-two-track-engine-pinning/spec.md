## MODIFIED Requirements

### Requirement: Rollback SHALL repoint the production pin to a previous FRG-passed release

Rollback of the factory production engine SHALL consist of repointing the production pin to a
previous FRG-passed release version (using retained prior-pin metadata when available) and
reinstalling the skill from that release tag. After rollback, doctor on a correctly reinstalled
host SHALL report track coherence with the restored pin. Rollback SHALL NOT require force-push
of product branches or autonomous merges.

Rollback SHALL be a separate protected operation under RecoverySupervisor. Automatic rollback
SHALL require an authenticated envelope that names the exact rollback operation and the retained
target. Generic promotion, install, or deployment failure SHALL NOT grant rollback authority.
Operator invocation of `pipeline factory-pin rollback` SHALL supply that envelope for the named
retained target. Engine-promote SHALL NOT invoke rollback as a side effect of install or verify
failure.

#### Scenario: Rollback restores prior pin target

- **WHEN** the production pin is at `1.30.0` and prior pin metadata names `1.29.1`
- **AND** the operator executes the documented rollback to `1.29.1` and reinstalls from that tag
- **THEN** the production pin SHALL name version `1.29.1`
- **AND** a coherent install SHALL report pinned-track match for `1.29.1`

#### Scenario: Rollback procedure is documented

- **WHEN** an operator reads the two-track / pin docs or FRG runbook cross-links
- **THEN** the rollback steps (repoint pin, reinstall from tag, verify with doctor) SHALL be present

#### Scenario: Generic deploy failure does not auto-rollback

- **WHEN** engine-promote install or live-identity verify fails after a pin mutation
- **AND** no authenticated rollback envelope names the rollback operation and retained target
- **THEN** the production pin SHALL remain at the post-promote identity
- **AND** rollback SHALL NOT run as a side effect of that failure

#### Scenario: Automatic rollback without an envelope is refused

- **WHEN** an automatic rollback is requested without an authenticated envelope that names the rollback operation and retained target
- **THEN** rollback SHALL NOT repoint the pin
- **AND** it SHALL NOT reinstall a prior tag
