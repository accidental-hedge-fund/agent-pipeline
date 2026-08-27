## ADDED Requirements

### Requirement: Builtin outer-host set SHALL include omp independent of adapter pi

The runtime outer-host registry SHALL include builtin host id `omp` after this change ships. Outer-host identity `omp` SHALL remain independent of stage adapter id `pi`. Shared orchestration SHALL consume `omp` from its manifest capability declarations and SHALL NOT dispatch OMP lifecycle by comparing adapter id `pi`.

#### Scenario: Conformance kit accepts builtin omp

- **WHEN** the shared outer-host conformance kit runs against builtin registered hosts
- **THEN** host id `omp` SHALL be present
- **AND** the `omp` manifest SHALL pass the kit
- **AND** the kit SHALL NOT require adapter id `pi` to equal `omp`

#### Scenario: Evidence records omp not pi as the outer host

- **WHEN** a run starts under outer host `omp` with implementer adapter `claude` and reviewer adapter `codex`
- **THEN** run evidence SHALL record outer-host identity `omp`
- **AND** SHALL NOT record outer-host identity `pi` solely because a Pi adapter exists

### Requirement: OMP initial lifecycle SHALL be stdout_only with portable follow

The `omp` outer-host manifest SHALL declare `material_progress_notify` with mapping surface `stdout_only`. Early run handoff, event follow, reattach, wait/cancel, terminal cleanup, and terminal summary SHALL name the portable baseline (launcher stdout and/or run-store `events.jsonl` via `pipeline logs --events --follow`, including detach) as support or fallback. The initial OMP host SHALL NOT require an OMP-native notify tool for supervision correctness.

#### Scenario: OMP notify surface is stdout_only

- **WHEN** the `omp` outer-host manifest is loaded
- **THEN** `material_progress_notify.mapping.surface` SHALL be `stdout_only`
- **AND** the fallback or how-to SHALL name stdout and/or `events.jsonl` follow

#### Scenario: Durable follow remains the portable pipeline path

- **WHEN** shared orchestration supervises a durable run launched from OMP
- **THEN** it SHALL use pipeline detach, run-store, and event-follow commands as the durable follow path
- **AND** SHALL NOT treat missing OMP-native notify as permission to skip supervision
