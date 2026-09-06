## ADDED Requirements

### Requirement: The Linux cgroup spawn provider SHALL report cleanup complete only after a fresh empty-cgroup observation

The Linux cgroup spawn provider SHALL report a successful cleanup return only after a fresh observation that the relevant cgroup is empty. Parent process exit, a fixed sleep, and delayed-write file absence SHALL NOT be the completeness observer. The provider SHALL NOT return success while known descendants remain. A failed remaining-PID read or parse SHALL NOT be treated as an empty observation. The drain SHALL observe existing descendant kill and SHALL NOT skip that kill. When nested cgroup creation is unavailable, existing non-cgroup descendant containment SHALL remain unchanged.

#### Scenario: Successful return requires an empty cgroup

- **WHEN** the Linux cgroup spawn provider created a cgroup for a provider spawn
- **AND** descendant kill has been sent
- **AND** a fresh read of that cgroup lists no remaining PIDs
- **THEN** the provider MAY report cleanup complete
- **AND** SHALL have observed that empty state on the return path

#### Scenario: Parent exit is not the completeness observer

- **WHEN** the direct child has exited
- **AND** the relevant cgroup still lists at least one PID
- **THEN** the provider SHALL NOT report cleanup success

#### Scenario: Known remaining members are never success

- **WHEN** the drain still observes remaining PIDs in the relevant cgroup
- **THEN** the provider SHALL NOT return success

#### Scenario: Unreadable cgroup is not an empty observation

- **WHEN** a read or parse of the relevant cgroup.procs fails during the drain
- **THEN** the provider SHALL NOT treat that failure as an empty cgroup
- **AND** SHALL NOT report cleanup success from that observation
- **AND** if no subsequent empty observation occurs before the deadline, SHALL return a typed timeout or error that identifies the cgroup

#### Scenario: Nested-cgroup unavailability does not require cgroup v2

- **WHEN** nested cgroup creation is unavailable on the host
- **THEN** the engine SHALL NOT fail solely because cgroup v2 nested mkdir is missing
- **AND** SHALL keep the existing non-cgroup descendant-containment path

### Requirement: The Linux cgroup spawn provider containment drain SHALL use a named bounded poll

The Linux cgroup spawn provider containment drain SHALL use a named 1,000 ms deadline. Polling intervals SHALL be at most 10 ms. The drain SHALL NOT use unbounded polling or unbounded sleeps. The drain SHALL wait on the cgroup that the provider already created and already kills. The drain SHALL NOT send a kill to processes outside that cgroup.

#### Scenario: Drain waits up to one second for emptiness

- **WHEN** descendant kill has been sent and the cgroup still lists members
- **THEN** the provider SHALL poll remaining members at most every 10 ms
- **AND** SHALL stop waiting at the named 1,000 ms deadline

#### Scenario: Unbounded waiting is forbidden

- **WHEN** the drain runs
- **THEN** it SHALL have a named finite deadline of 1,000 ms
- **AND** SHALL NOT poll without a deadline
- **AND** SHALL NOT sleep without a bound

### Requirement: Drain deadline expiry with remaining members SHALL be a typed closed failure

If the named drain deadline expires with remaining cgroup members, or without a successful empty-cgroup observation, the Linux cgroup spawn provider SHALL return a typed timeout or error that identifies the cgroup and, when known, the remaining PIDs. Remaining PIDs at deadline SHALL be classified as not known complete and not known absent. A failed remaining-PID observation at deadline SHALL be classified the same way. That result SHALL NOT be success. That result SHALL NOT be classified as the provider runtime ceiling. The engine SHALL NOT project a human-authority hold from drain timeout. Observation SHALL keep leftover descendants as typed `planning-facts-provider-contract` with failure class `containment`. The identifying cgroup and remaining-PID fields SHALL be dedicated typed evidence on the spawn result and observation failure. Those fields SHALL remain present when provider stderr is already at `max_stderr_bytes`.

#### Scenario: Deadline expiry names the cgroup and remaining PIDs

- **WHEN** the named 1,000 ms drain deadline expires
- **AND** a fresh cgroup read still lists one or more PIDs
- **THEN** the provider SHALL return a typed timeout or error
- **AND** that output SHALL identify the cgroup
- **AND** that output SHALL identify the remaining PIDs
- **AND** the return SHALL NOT be success

#### Scenario: Containment diagnostics survive stderr capture

- **WHEN** drain deadline expires with remaining members
- **AND** provider stderr already filled the configured cap
- **THEN** the typed failure SHALL still identify the cgroup
- **AND** SHALL still identify the remaining PIDs

#### Scenario: Drain timeout is not a human hold and not a runtime-ceiling timeout

- **WHEN** drain deadline expires with remaining members
- **THEN** the outcome SHALL be an engine-owned containment failure
- **AND** SHALL NOT be classified solely as the provider runtime ceiling
- **AND** SHALL NOT be `needs-human` solely because the drain timed out

### Requirement: The daemonized-descendant regression SHALL acknowledge readiness before the parent may finish

The existing daemonized delayed-write regression SHALL emit a positive readiness or acknowledgement signal from the descendant before the parent operation may finish. After a successful provider cleanup return, the delayed marker file SHALL be absent. The delayed-write assertion window SHALL NOT be increased. Automated tests covered by `npm run ci` SHALL fail if a successful provider return is followed by that delayed write. The focused regression `defaultSpawnProvider cgroup containment kills a setsid daemon before a delayed write lands` SHALL pass 25 consecutive executions on Linux cgroup v2.

#### Scenario: Parent cannot finish before daemon readiness

- **WHEN** the regression fixture starts a `setsid` descendant that will write a delayed marker
- **THEN** that descendant SHALL emit a positive readiness or acknowledgement signal
- **AND** the parent operation SHALL NOT finish until that signal is observed

#### Scenario: Delayed write does not land after successful cleanup

- **WHEN** the Linux cgroup spawn provider returns success for the daemonized delayed-write fixture
- **THEN** the delayed marker file SHALL be absent
- **AND** the assertion window used to check that absence SHALL NOT be longer than the existing window

#### Scenario: The delayed-write bite is not hidden

- **WHEN** a daemonized descendant writes the delayed marker after the provider reported cleanup complete
- **THEN** the regression SHALL fail
- **AND** the suite SHALL NOT skip, quarantine, or widen the assertion to hide that write
