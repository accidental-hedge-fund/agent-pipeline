## MODIFIED Requirements

### Requirement: recover-parked SHALL expose a closed result contract for train and CLI consumers

The command and its pure engine entrypoint SHALL return a closed status from at least: `deterministic-cleared`, `recovered`, `still-parked`, `already-spent`, `not-parked`, `fail-closed`. CLI consumers and RecoverySupervisor recipes that invoke recover-parked SHALL use that result (or the shared entrypoint) rather than inventing a second classifier. Thin hosts that only invoke the CLI SHALL stop or hold when the outcome is still parked (or equivalent non-zero park result) and SHALL NOT invent override. Train SHALL NOT invoke recover-parked as an in-process consumer.

#### Scenario: Train maps recovered vs still-parked from the shared result

- **WHEN** train observes a parked item
- **THEN** train SHALL NOT invoke recover-parked
- **AND** RecoverySupervisor SHALL retain ownership of that item
- **AND** train SHALL NOT invent an override
- **AND** CLI consumers that do invoke recover-parked SHALL still map `recovered` or `deterministic-cleared` as cleared and `still-parked`, `already-spent`, or `fail-closed` as still parked

#### Scenario: Re-entry does not recursively invoke recover-parked

- **WHEN** recover-parked re-enters `pipeline single` / advance for the same issue after a successful clear
- **THEN** that re-entry SHALL carry an internal guard that prevents nested recover-parked on the same stack
- **AND** SHALL preserve the existing issue-run lock contract for that issue

## ADDED Requirements

### Requirement: recover-parked SHALL remain an operator CLI independent of train

`pipeline recover-parked <n>` SHALL remain a loop-isolated operator and external-supervisor surface. Train, merge, and merge-queue SHALL NOT auto-invoke it. Invoking recover-parked SHALL NOT grant merge authority and SHALL NOT widen the original merge envelope.

#### Scenario: Operator can still recover a parked issue

- **WHEN** an operator runs `pipeline recover-parked 42`
- **THEN** the command SHALL run its existing deterministic-first supervisor pass
- **AND** it SHALL NOT merge a pull request

#### Scenario: Train production wiring does not call recover-parked

- **WHEN** production `pipeline train` parks an item
- **THEN** the train entry point SHALL NOT call the recover-parked CLI or shared entrypoint
- **AND** a hermetic test SHALL fail if production train deps wire `recoverParked`
