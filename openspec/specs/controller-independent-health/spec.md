# controller-independent-health Specification

## Purpose
TBD - created by archiving change factory-aggregate-status-and-controller-health. Update Purpose after archive.
## Requirements
### Requirement: The controller SHALL advance a process heartbeat on a bounded independent cadence

While a factory controller (the #890 macro-controller when active, otherwise the durable loop supervisor acting as the live item driver) holds a run and has not exited terminally, it SHALL refresh controller-owned heartbeat evidence on a bounded independent cadence during long item dispatches, expected waits, and recovery backoff. Heartbeat advance SHALL NOT require model or worker progress messages. The cadence bound SHALL be injectable for unit tests.

#### Scenario: Heartbeat advances during a long blocking dispatch

- **WHEN** the controller holds a run and a whole-item dispatch remains in progress longer than
  one independent heartbeat interval
- **AND** no model/worker progress message is observed
- **THEN** the controller-owned `heartbeat_at` (or equivalent) SHALL advance at least once before
  the dispatch completes

#### Scenario: Heartbeat advances during expected wait and recovery backoff

- **WHEN** the controller is sleeping or waiting inside an expected wait or recovery backoff
  window longer than one independent heartbeat interval
- **THEN** the heartbeat evidence SHALL continue to advance on the independent cadence
- **AND** SHALL NOT require a durable ledger transition to refresh

#### Scenario: Cadence is injectable in tests

- **WHEN** a unit test injects a short heartbeat interval and a controllable clock
- **THEN** the test SHALL observe heartbeat refreshes without real wall-clock multi-second waits
  beyond the test's injected progression

---

### Requirement: Heartbeat refresh SHALL stop after lock loss or terminal exit and failed persistence SHALL be visible

After the controller loses the run lock or records a terminal exit, it SHALL stop refreshing
heartbeat evidence for that run. If a heartbeat persistence attempt fails while the controller
still believes it is live, health projection SHALL surface the persistence failure and SHALL
NOT report healthy liveness solely from an in-memory belief that the write succeeded.

#### Scenario: Heartbeat stops after terminal exit

- **WHEN** the controller records a terminal stop and exits the run loop
- **THEN** no further independent heartbeat refresh for that run SHALL be attempted after the
  terminal exit path completes

#### Scenario: Heartbeat stops after lock loss

- **WHEN** the controller detects it no longer holds the run lock
- **THEN** independent heartbeat refresh for that run SHALL stop
- **AND** subsequent status SHALL NOT claim a fresh healthy heartbeat from that controller
  instance

#### Scenario: Failed heartbeat persistence is not reported healthy

- **WHEN** a heartbeat write fails through the injected store seam
- **THEN** factory health projection SHALL expose a non-healthy or degraded liveness/write signal
- **AND** SHALL NOT claim healthy process liveness as if the heartbeat were durably fresh

---

### Requirement: Health SHALL represent process liveness, durable progress, and expected waiting independently

Controller health projection SHALL expose three independent dimensions:

1. **Process liveness** — whether controller heartbeat and same-host process/service probes
   indicate a live controller.
2. **Durable workflow progress** — whether durable ledger/event/action evidence has advanced.
3. **Expected waiting** — whether the controller is in a recorded expected wait (including CI,
   provider cooldown, recovery backoff, dependency, capacity, or human) with a deadline.

A single conflated boolean MUST NOT be the only health signal. Factory status consumers SHALL be
able to observe each dimension without inferring the others.

#### Scenario: Live process with no recent durable progress during expected wait

- **WHEN** the controller heartbeat is fresh
- **AND** an expected wait with a future deadline is recorded
- **AND** no durable progress has occurred during the wait
- **THEN** process liveness SHALL report live
- **AND** expected waiting SHALL report waiting with that kind and deadline
- **AND** durable progress MAY report idle or not-recent
- **AND** the coarse classification SHALL NOT be `suspected_stuck` solely for lack of progress
  during the wait

#### Scenario: Dimensions remain separable in the read model

- **WHEN** factory status JSON is assembled
- **THEN** the health block SHALL include distinct fields or nested objects for liveness,
  durable progress, and expected waiting
- **AND** a change to one dimension's evidence SHALL NOT force the others to identical values

---

### Requirement: `suspected_stuck` SHALL require live controller plus overdue started operation without durable progress

The coarse classification `suspected_stuck` SHALL be emitted only when all of the following hold:

- controller liveness evidence is fresh (independent heartbeat within the liveness bound)
- an operation was **explicitly started** and recorded with a deadline
- the injected clock is past that deadline
- no durable progress has been recorded since the operation start

Absence of an operation deadline SHALL NOT produce `suspected_stuck` by wall-clock age alone.

#### Scenario: Overdue operation with live controller and no progress is stuck

- **WHEN** heartbeat is fresh
- **AND** operation `dispatch_item` started with deadline T1
- **AND** clock is after T1
- **AND** no durable progress exists after the operation start
- **THEN** coarse health SHALL be `suspected_stuck`

#### Scenario: Fresh heartbeat alone is not stuck

- **WHEN** heartbeat is fresh
- **AND** no operation with a past deadline is recorded
- **THEN** coarse health SHALL NOT be `suspected_stuck`

#### Scenario: Overdue operation with durable progress is not stuck

- **WHEN** an operation is past its deadline
- **AND** durable progress was recorded after the operation start
- **THEN** coarse health SHALL NOT be `suspected_stuck` solely from the deadline breach

---

### Requirement: `dead` SHALL require stale heartbeat plus same-host absence proof; otherwise `unknown`

The coarse classification `dead` SHALL be emitted only when heartbeat evidence is stale (or
absent past the liveness bound) **and** a same-host process/service probe proves the recorded
controller process or service is not present. When the recorded holder is on a different host,
or when process/service evidence is insufficient to prove absence, classification SHALL be
`unknown` and SHALL NOT be upgraded to `dead`.

#### Scenario: Stale heartbeat and dead same-host pid is dead

- **WHEN** heartbeat is older than the liveness bound
- **AND** the process record hostname matches the local host
- **AND** the recorded pid is proven not alive by the injected probe
- **THEN** coarse health SHALL be `dead`

#### Scenario: Cross-host holder is unknown not dead

- **WHEN** heartbeat is stale
- **AND** the process record hostname differs from the local host
- **THEN** coarse health SHALL be `unknown`
- **AND** SHALL NOT be `dead`

#### Scenario: Insufficient process evidence is unknown

- **WHEN** heartbeat is stale
- **AND** no reliable same-host process or service probe result is available
- **THEN** coarse health SHALL be `unknown`
- **AND** SHALL NOT be `dead`

---

### Requirement: Expected waiting before a recorded deadline SHALL be healthy waiting not stuck

When the controller records an expected wait of kind CI, provider cooldown, recovery backoff, dependency, capacity, or human, and the injected clock is still before the wait's recorded deadline, coarse health SHALL classify the situation as healthy waiting (or an equivalent non-stuck waiting state) rather than `suspected_stuck` or `dead`, provided liveness evidence is consistent with a live or intentionally paused controller as defined by the wait record.

#### Scenario: Provider cooldown before deadline is waiting

- **WHEN** provider cooldown wait is recorded with deadline T2
- **AND** clock is before T2
- **AND** heartbeat remains fresh on the independent cadence
- **THEN** expected waiting SHALL report provider cooldown
- **AND** coarse health SHALL NOT be `suspected_stuck`

#### Scenario: CI wait before deadline is waiting

- **WHEN** a CI wait with future deadline is recorded
- **THEN** coarse health SHALL NOT be `suspected_stuck` solely because durable item progress is
  idle during that CI wait

#### Scenario: Human wait before deadline is waiting

- **WHEN** a human-authority wait or hold with a recorded future check deadline is present
- **THEN** coarse health SHALL NOT be `suspected_stuck` solely for lack of autonomous progress
  before that deadline

---

### Requirement: Independent health classification SHALL be unit-tested with injected clocks and probes

Classification of liveness, progress, waiting, `suspected_stuck`, `dead`, and `unknown` SHALL be
covered by unit tests that inject clocks, process/service probes, and durable evidence fakes.
Tests SHALL perform no real network, git, or subprocess calls.

#### Scenario: Matrix covers stuck dead unknown and waiting

- **WHEN** the health classification unit tests run
- **THEN** they SHALL include at least one case each for healthy waiting, `suspected_stuck`,
  same-host `dead`, cross-host `unknown`, and insufficient-evidence `unknown`
- **AND** each case SHALL use injected seams only

