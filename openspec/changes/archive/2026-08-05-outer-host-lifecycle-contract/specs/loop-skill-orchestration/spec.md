## ADDED Requirements

### Requirement: Default loop orchestration SHALL consume outer-host lifecycle capabilities without host-name branching

Default multi-item loop host packaging SHALL be expressed against the active outer host's
declared lifecycle capabilities. That packaging covers early run handoff observation, loop and
linked-advance event follow, material notify, reattach after cancelled wait, terminal stop on
`loop_run_stopped` / linked advance terminal conditions, final summary, and monitor cleanup.
Shared loop orchestration text and helpers SHALL NOT encode lifecycle dispatch as host-name
equality checks against a closed built-in set.

Dual-follow and material-filter obligations remain; notify surfaces come from the host's declared
material-progress mapping or portable fallback.

#### Scenario: Capability-driven loop supervision applies without host-name switch

- **WHEN** a registered outer host declares early handoff, event follow, reattach, terminal
  cleanup, and terminal summary (or portable fallbacks)
- **AND** default loop orchestration is selected for that host
- **THEN** the shared contract SHALL require handoff observation, follow, reattach after
  cancelled wait, cleanup, and final summary from those declarations
- **AND** SHALL NOT require a new shared host-name branch to enable those steps

#### Scenario: Loop material notify uses manifest mapping

- **WHEN** loop orchestration emits or requires material progress notification
- **THEN** it SHALL use the outer host's declared material-progress notify mapping or fallback
- **AND** SHALL NOT hard-require a single host's notify tool in shared loop prose consumed by
  other hosts
