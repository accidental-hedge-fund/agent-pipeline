## MODIFIED Requirements

### Requirement: A documented idempotent update command SHALL refresh the installed skill in place

The project SHALL document a one-step update command that refreshes the installed
skill in place by reusing the existing installer `update` verb
(`npx github:accidental-hedge-fund/agent-pipeline update`, or
`node scripts/install.mjs update` from a clone). Running the command SHALL be
idempotent: a second run on an already-current install SHALL produce a net no-op
with no error. The command SHALL be documented in the README and/or linked
durable install documentation, and the `install:version-freshness` warning
remediation SHALL name it. A generated short host one-pager MAY expose the
`update` verb and link to those docs; it SHALL NOT be required to copy the
installer tutorial.

#### Scenario: Update refreshes the install in place

- **WHEN** the operator runs the documented update command against a stale install
- **THEN** the installed skill SHALL be refreshed in place to the installed source's
  version

#### Scenario: Running the update command twice is idempotent

- **WHEN** the documented update command is run twice in succession
- **THEN** the second run SHALL be a net no-op and SHALL exit without error

#### Scenario: The warn remediation names the update command

- **WHEN** the `install:version-freshness` check reports `warn`
- **THEN** its remediation text SHALL contain the documented update command

#### Scenario: Generated one-pager stays out of the install tutorial

- **WHEN** an operator reads a generated host one-pager
- **THEN** it MAY expose `update` in the compact verb table and point to the
  durable install documentation
- **AND** it SHALL NOT be required to reproduce the one-step installer tutorial
