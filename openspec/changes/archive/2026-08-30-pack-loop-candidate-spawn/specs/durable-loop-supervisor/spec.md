## ADDED Requirements

### Requirement: An acknowledged pack-loop process death SHALL allow one recorded resume

When an acknowledged pack-loop supervisor process dies while its run remains resumable and non-terminal, the engine SHALL allow exactly one durably recorded resume for that exact loop id. The resume budget SHALL be run-lineage scoped: persist `resume_count` on the binding for that `loop_run_id`. The failed process identity SHALL be recorded as audit evidence only. A second acknowledged liveness loss for that same loop SHALL be terminal even when the dead process has a new PID. The resumed process SHALL publish a new valid `loop_run_handoff` before it is treated as dispatched or live. Unreadable identity evidence SHALL NOT authorize that resume. The resume record SHALL persist under the run lock so a later invoke cannot claim a second grant.

#### Scenario: First acknowledged death resumes once

- **WHEN** bound loop `L` has a valid `loop_run_handoff`
- **AND** the acknowledged process is dead
- **AND** the run is resumable and non-terminal
- **AND** `resume_count` for `L` is 0
- **THEN** the engine SHALL spawn exactly one resume of `L`
- **AND** it SHALL persist `resume_count` 1 and the failed process identity as audit evidence
- **AND** the new process SHALL emit a new valid `loop_run_handoff` before `dispatch_state` is `dispatched`

#### Scenario: Second liveness loss is terminal

- **WHEN** loop `L` already has `resume_count` 1
- **AND** the resumed process dies or becomes not-live
- **THEN** the engine SHALL treat that liveness loss as terminal
- **AND** it SHALL NOT spawn another pack-loop child for `L`
- **AND** it SHALL NOT mint a new grant because the dead process has a new PID

#### Scenario: Unreadable identity does not grant resume

- **WHEN** `supervisor.json` or lock identity evidence for loop `L` is unreadable or malformed
- **THEN** the engine SHALL NOT record a resume grant from that evidence
- **AND** it SHALL apply the bounded observation window and then fail closed

## MODIFIED Requirements

### Requirement: The supervisor SHALL persist a process-identity record with a refreshed heartbeat

The supervisor SHALL write a durable process-identity record in the run directory when it attaches
to a run, carrying the engine, the process id, the hostname, a per-boot identifier, the start time,
a heartbeat time, and the held lock token. It SHALL refresh the heartbeat time on a periodic process
cadence independently of cycle completion, and it SHALL still refresh on every cycle. The cadence
and the stale threshold SHALL be versioned engine safety invariants. Repository configuration SHALL
NOT lengthen the cadence or raise the stale threshold beyond those invariants. Pack-loop liveness
consumers SHALL treat a heartbeat older than the engine stale threshold as not-live even when a
cycle is still in flight. The record SHALL be distinct from the run lock — the lock governs write
authority; the process record identifies which supervisor process is currently driving and whether
it is still alive and progressing. The record SHALL be written through the store's injectable seam
so a unit test drives it with no real process, network, or git call.
Heartbeat writes SHALL require current lock ownership. A heartbeat timer
SHALL be started after attach through an injectable timer seam and SHALL
be cleared when the drive ends. Missing `heartbeat_at` after acknowledgement
SHALL be not-live. A malformed or future `heartbeat_at` SHALL be unreadable
identity: unknown inside the observation window, then fail closed.

#### Scenario: The process record is written at attach and heartbeats each cycle

- **WHEN** the supervisor attaches to a run and then completes cycles
- **THEN** a process-identity record carrying the engine, pid, hostname, per-boot id, start time,
  heartbeat time, and lock token SHALL exist in the run directory
- **AND** its heartbeat time SHALL advance on each subsequent cycle

#### Scenario: Heartbeat advances during a long in-flight cycle

- **WHEN** the supervisor is inside a cycle that lasts longer than the engine heartbeat cadence
- **THEN** `heartbeat_at` SHALL still advance before that cycle completes
- **AND** a liveness consumer SHALL NOT classify the process as stale solely because the cycle
  has not finished

#### Scenario: Repository config cannot weaken the stale threshold

- **WHEN** repository configuration attempts to raise the heartbeat stale threshold or lengthen
  the cadence beyond the engine invariant
- **THEN** the engine SHALL keep the versioned invariant
- **AND** pack-loop liveness SHALL still use that invariant

#### Scenario: The process record composes with, and does not replace, the lock

- **WHEN** a supervisor holds the run
- **THEN** both the run lock and the process-identity record SHALL be present
- **AND** the process record SHALL NOT be treated as a second write-authority lock

#### Scenario: Missing heartbeat after acknowledgement is not live

- **WHEN** bound loop `L` has a valid `loop_run_handoff`
- **AND** `supervisor.json` omits `heartbeat_at` or the field is empty
- **THEN** liveness SHALL NOT be `live`

#### Scenario: Malformed or future heartbeat fails closed after the observation window

- **WHEN** `heartbeat_at` is not a parseable timestamp
- **OR** `heartbeat_at` is more than one second in the future
- **AND** the observation window has expired
- **THEN** liveness SHALL be fail-closed identity error
- **AND** it SHALL NOT count as fresh

#### Scenario: Heartbeat timer is cleared when drive ends

- **WHEN** `driveSupervisor` returns or throws
- **THEN** the injected heartbeat timer SHALL be cleared
- **AND** a later fake tick SHALL NOT write `supervisor.json`
