## ADDED Requirements

### Requirement: Default advance orchestration SHALL consume outer-host lifecycle capabilities without host-name branching

Default single-issue advance host packaging SHALL be expressed against the active outer host's
declared lifecycle capabilities from the outer-host contract. That packaging covers status
pre-check, detach/launch, event follow, material notify, reattach after cancelled wait, terminal
stop, final summary, and terminal cleanup. Shared advance orchestration text and helpers SHALL
NOT encode lifecycle dispatch as host-name equality checks against a closed built-in set.

Closed reattach-until-terminal and cancelled-wait-is-not-terminal behaviors SHALL remain required
for hosts that declare reattach/event_follow support (or portable fallbacks), and SHALL be covered
by host-agnostic regression fixtures rather than provider or host-name tables.

#### Scenario: Capability-driven advance steps apply to a non-built-in host

- **WHEN** a registered outer host declares event follow, reattach, terminal cleanup, and
  terminal summary (or portable fallbacks)
- **AND** default advance orchestration is selected for that host
- **THEN** the shared contract SHALL require follow-until-terminal, reattach after cancelled wait,
  cleanup, and final summary using those declarations
- **AND** SHALL NOT require a new shared `if (host === "<id>")` branch to enable those steps

#### Scenario: Closed reattach behavior is a contract fixture not a host table

- **WHEN** regression coverage for cancelled-wait reattach runs
- **THEN** it SHALL assert the outer-host reattach/wait_cancel contract (capability-driven)
- **AND** SHALL NOT implement the requirement only as a table of built-in host names
