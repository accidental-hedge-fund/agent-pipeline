# scoped-autonomous-factory-operations Specification

## Purpose

This capability formerly described a shipped Hermes/Buzz grant factory under
`ops/hermes-factory`. That pilot was removed from the product tree. The
requirements below record the **current** product rule: no second control plane
in-repo; external supervisors compose the Pipeline CLI; integrate trains belong
in agent-pipeline.

## Requirements

### Requirement: The repository SHALL NOT ship a Hermes factory control plane

The repository SHALL NOT include an `ops/hermes-factory` (or equivalent) package
that implements a durable grant journal, systemd factory action bus, or
wrapper-local hybrid FRG attestor as a product surface. External supervisors MAY
invoke existing Pipeline CLI commands. They SHALL NOT be required to install a
second durable scheduler from this repository.

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

#### Scenario: External supervisor may only use existing merge surfaces

- **WHEN** an external supervisor needs to merge a ready-to-deploy issue PR
- **THEN** it SHALL invoke the existing `pipeline merge` (or merge-queue apply) surface
- **AND** it SHALL NOT gain merge authority from repository configuration alone
