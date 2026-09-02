## ADDED Requirements

### Requirement: Doctor SHALL report continuous-liveness status without projecting human authority

`pipeline doctor` SHALL include a deterministic continuous-liveness check that does not invoke a language model. The check SHALL report whether a Liveness Provider keep-alive path is `configured`, `available`, `active`, or `degraded` / `unavailable`. Unavailable or unconfigured continuous liveness SHALL be a typed capability condition. It SHALL NOT be classified as human authority, a Decision Request, or a needs-human hold. Absence of systemd, launchd, a container supervisor, or a harness worker SHALL NOT fail doctor as if a person must own the run. A configured adapter that is incoherent or broken MAY fail or warn as `degraded` with remediation that names the adapter, not a human-authority class. `pipeline doctor --json` SHALL expose the same discriminant on the check record.

#### Scenario: Unconfigured keep-alive is a capability condition, not a human hold

- **WHEN** `pipeline doctor` runs on a one-shot CLI host with no keep-alive adapter configured
- **THEN** the continuous-liveness check SHALL report `unavailable` or not-configured
- **AND** the reason SHALL be a typed capability condition
- **AND** the summary SHALL NOT use human-authority or needs-human language
- **AND** that absence SHALL NOT by itself cause doctor to fail

#### Scenario: Active worker is reported active

- **WHEN** a keep-alive adapter is configured and a fenced supervisor is live
- **THEN** the check SHALL report `active`
- **AND** `pipeline doctor --json` SHALL include that discriminant on the check record

#### Scenario: Configured but broken adapter is degraded

- **WHEN** a keep-alive adapter is configured and cannot claim a fence or probe identity
- **THEN** the check SHALL report `degraded` or `unavailable`
- **AND** remediation SHALL name the adapter and the typed capability condition
- **AND** the check SHALL NOT describe the fault as a human decision

#### Scenario: The check is unit-testable through doctor deps

- **WHEN** unit tests drive the continuous-liveness check with injected adapter and identity fakes
- **THEN** they SHALL assert `configured`, `available`, `active`, and `degraded` / `unavailable` outcomes
- **AND** they SHALL perform no real systemd, launchd, container, network, git, or subprocess call
