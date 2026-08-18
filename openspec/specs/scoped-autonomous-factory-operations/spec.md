# scoped-autonomous-factory-operations Specification

## Purpose

This capability formerly described a shipped Hermes/Buzz grant factory under
`ops/hermes-factory`. That pilot was removed from the product tree. The
requirements below record the **current** product rule: no second control plane
in-repo; external supervisors map authenticated intent into the Pipeline CLI;
integrate trains and ship lifecycle decisions belong in agent-pipeline.

## Requirements

### Requirement: The repository SHALL NOT ship a Hermes factory control plane

The repository SHALL NOT include an `ops/hermes-factory` (or equivalent) package
that implements a durable grant journal, systemd factory action bus, or
wrapper-local hybrid FRG attestor as a product surface. External supervisors MAY
invoke explicit Pipeline CLI coordinator commands with a bounded authorization
document. They SHALL NOT be required to install a second durable scheduler from
this repository.

#### Scenario: Product tree has no factory ops package

- **WHEN** a clean checkout of the default branch is inspected
- **THEN** it SHALL NOT contain `ops/hermes-factory`
- **AND** the default `npm run ci` script SHALL NOT invoke a hermes-factory test suite

#### Scenario: Ordinary CLI behavior is unchanged by removal

- **WHEN** an operator runs `pipeline advance`, `pipeline single`, or `pipeline loop` without a merge command
- **THEN** those commands SHALL still stop at `pipeline:ready-to-deploy`
- **AND** they SHALL NOT merge pull requests

---

### Requirement: Merge authority SHALL remain loop-isolated and not repository configuration

Merging SHALL use only loop-isolated, operator-authorized surfaces (`pipeline merge`,
`pipeline merge-queue --apply`, and any later explicit train-merge surface). The
repository configuration schema SHALL reject `auto_merge` and factory-authority
keys. `.github/pipeline.yml` SHALL NOT authorize merges.

#### Scenario: Config cannot enable unattended merge

- **WHEN** a repository sets `auto_merge` or a factory-authority key in `.github/pipeline.yml`
- **THEN** strict configuration validation SHALL reject the unknown key

#### Scenario: External supervisor uses Pipeline-owned merge surfaces

- **WHEN** an external supervisor needs to merge a ready-to-deploy issue PR
- **THEN** it SHALL invoke `pipeline merge`, merge-queue apply, or the authorized
  `pipeline ship` coordinator that composes those Pipeline-owned gates
- **AND** it SHALL NOT gain merge authority from repository configuration alone

---

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
