## ADDED Requirements

### Requirement: The queue command SHALL be a supervised-lifecycle form

`pipeline queue` SHALL be classified `supervised-lifecycle` in the command-form inventory. Nested item drives SHALL report typed operation observations to RecoverySupervisor. A nested mechanical fault SHALL NOT cause the queue handler to terminate through raw `process.exit(1)` as a lifecycle terminal, and SHALL NOT leave that item ownerless. Independent siblings SHALL continue under existing isolation and pickup-gate law. Queue SHALL NOT merge any PR. Config-resolution usage errors MAY still exit 2 before any run is started.

#### Scenario: Queue is inventoried as supervised

- **WHEN** the command-form inventory is inspected for `queue`
- **THEN** the form SHALL declare `execution_disposition: supervised-lifecycle`
- **AND** it SHALL NOT be classified as read-only or bounded-atomic-administration

#### Scenario: Nested mechanical fault stays owned

- **WHEN** a nested pipeline run in a queue batch throws, times out, or exits nonzero after admission
- **THEN** that item SHALL be reported as a RecoverySupervisor observation
- **AND** the queue handler SHALL NOT call `process.exit(1)` as a lifecycle terminal for that fault
- **AND** other in-flight and queued runs SHALL proceed under existing isolation law

#### Scenario: Queue process death does not ownerless-terminate nested drives

- **WHEN** the queue process dies after it has started nested drives
- **THEN** each admitted nested Logical Operation SHALL remain owned
- **AND** RecoverySupervisor SHALL retain those operations
