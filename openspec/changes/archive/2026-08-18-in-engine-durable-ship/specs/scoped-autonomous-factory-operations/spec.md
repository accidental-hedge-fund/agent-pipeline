## REMOVED Requirements

### Requirement: Ship authority SHALL be authenticated, immutable, event-bound, and expiring

**Reason:** Issue #1096 makes `pipeline ship --milestone vX.Y.Z` the operator product. The signed grant / `--authorization` path is not this feature and MUST NOT be revived as the operator surface. Keeping the grant requirement would force hosts to mint a second authority document and recreate the Tugboat/Buzz composer.

**Migration:** Operators and hosts invoke `pipeline ship --milestone vX.Y.Z`. Operator invocation is the loop-isolated authority, the same class as `pipeline train --merge`. Do not write or require a signed grant JSON for that command.

## ADDED Requirements

### Requirement: Ship authority SHALL be operator invocation of the milestone command

The explicit operator `pipeline ship` surface SHALL be `pipeline ship --milestone vX.Y.Z`. Invoking that command SHALL be sufficient authority to compose existing loop-isolated train-merge, merge, release-finish, and engine-promote surfaces. The surface SHALL NOT require `--authorization` or a signed grant document. Repository configuration, chat prose, a display name, or a later message SHALL NOT widen ship authority beyond that invocation’s milestone coordinates. A second invoke of the same repository, base, and milestone SHALL resume the existing ship record rather than start a sibling implement.

External supervisors MAY invoke that command. They SHALL NOT be required to install a grant factory, MessagingPort, or ship-auth issuer from this repository.

#### Scenario: Milestone command authorizes one ship

- **WHEN** an operator or host runs `pipeline ship --milestone v1.39.3` for the current repository and base
- **THEN** Pipeline SHALL bind the ship to that repository, base, and milestone before the first mutation
- **AND** every later ship phase SHALL remain bound to those coordinates
- **AND** the command SHALL NOT require a grant file

#### Scenario: Replay of the same milestone is idempotent

- **WHEN** the same `pipeline ship --milestone v1.39.3` is invoked again
- **THEN** Pipeline SHALL resume the existing ship record for those coordinates
- **AND** it SHALL NOT create a second train, release PR, or merge mutation that farms a newer sibling while an earlier ready-to-deploy PR is open

#### Scenario: Config still cannot authorize merge

- **WHEN** a repository sets `auto_merge` or a factory-authority key in `.github/pipeline.yml`
- **THEN** strict configuration validation SHALL still reject the unknown key
- **AND** `pipeline advance` SHALL still stop at `pipeline:ready-to-deploy` without merging
