## ADDED Requirements

### Requirement: Detached launch SHALL preserve harness CLI discovery equivalence with foreground

The detached process’s environment treatment for harness CLI discovery SHALL be equivalent to the
foreground process that resolved the launch. The launcher SHALL NOT strip or replace `PATH` (or
equivalent discovery variables) in a way that makes a command resolvable in foreground but missing
under detach for the same operator machine state.

Where the production preflight or launch path has resolved a harness executable to an absolute
path, detached execution SHALL prefer that absolute path (or an environment that still resolves to
the same binary) so detached and foreground invocations of the same adapter command do not diverge
solely due to shell-vs-detached PATH differences.

#### Scenario: Foreground-resolvable harness remains resolvable after detach

- **WHEN** a harness CLI command is resolvable on PATH in the foreground launcher environment
- **AND** a detached run is started for an issue that will invoke that harness
- **THEN** the detached process’s harness-discovery environment SHALL still resolve that command
  to an equivalent executable
- **OR** the launch record SHALL carry the absolute path for use by production invoke

#### Scenario: Absolute executable is available before detached model work

- **WHEN** production preflight resolves an adapter command to an absolute path successfully before
  or at detached launch packing
- **THEN** that absolute path SHALL be recorded for the run’s harness discovery or probe consumers
- **AND** detached production invoke SHALL NOT depend on a strictly narrower PATH than the
  launcher used for resolution

#### Scenario: PATH parity regression is testable without real network

- **WHEN** a unit or integration-style test injects launcher environment and resolution deps
- **THEN** a case where foreground PATH finds a command and a stripped detach env would not
  SHALL fail the parity assertion unless absolute-path packing preserves discovery
- **AND** the test SHALL NOT require a real GitHub or model network call
