## ADDED Requirements

### Requirement: A CLI-harness cell SHALL deliver its declared effort coordinate to the harness invocation

A cell executed through a local CLI harness SHALL cause the harness process to be invoked with the
effort declared by that cell's treatment, expressed as the resolved harness adapter's own native
reasoning-effort control. A cell whose treatment declares no effort SHALL be invoked with no
effort control at all, exactly as before. The delivered effort SHALL be observable in the harness
process's command line, and SHALL be the same value the cell's recorded treatment coordinates
claim.

#### Scenario: A declared effort reaches the harness command line

- **WHEN** a cell's treatment declares an effort and is executed through a local CLI harness
- **THEN** the harness process SHALL be invoked with that adapter's native reasoning-effort
  control carrying the declared value

#### Scenario: Two cells differing only in effort invoke the harness differently

- **WHEN** two cells share a fixture, harness, and model but declare different efforts
- **THEN** their harness invocations SHALL differ in the delivered reasoning-effort control

#### Scenario: A cell declaring no effort is invoked unchanged

- **WHEN** a cell's treatment declares no effort
- **THEN** the harness process SHALL be invoked with no reasoning-effort control

#### Scenario: Effort delivery is verified at the command line, not at the call site

- **WHEN** the runner's effort-delivery behavior is tested
- **THEN** the assertion SHALL be made against the arguments the harness process actually
  receives, so an invocation option that is accepted but discarded before reaching the process
  SHALL fail the test

### Requirement: A cell SHALL NOT be recorded as a completed treatment carrying an effort the resolved harness cannot express

The runner SHALL fail a cell before invoking the harness whenever that cell's treatment declares
an effort the resolved harness cannot express — an unregistered custom CLI, or an adapter whose
declared capabilities include no reasoning-effort control — and SHALL classify the failure as an
infrastructure or configuration failure rather than as a treatment outcome. The
failure message SHALL name the harness and the requested effort. A cell that declares no effort
SHALL be unaffected by this rule.

#### Scenario: An inexpressible effort fails before invocation

- **WHEN** a cell declares an effort against a harness with no reasoning-effort control
- **THEN** the cell SHALL fail before the harness is invoked
- **AND** the failure SHALL be recorded as an infrastructure or configuration failure, not as a
  completed treatment outcome
- **AND** the failure message SHALL name the harness and the requested effort

#### Scenario: A cell declaring no effort still runs on such a harness

- **WHEN** a cell declares no effort against a harness with no reasoning-effort control
- **THEN** the cell SHALL execute normally
