## MODIFIED Requirements

### Requirement: The supervisor SHALL drive a compiled run to a terminal condition through the durable engine

The durable loop supervisor SHALL be an Agent Pipeline-owned in-repo runtime that, given an
already-compiled and locked run, advances that run by repeating a bounded cycle: run a
reconciliation pass over live truth, select the next dependency-ready active item honoring the
contract's `max_active_items: 1`, dispatch that item, and record its outcome through the durable
engine's transition, recovery, and pause paths. The supervisor SHALL continue until the run reaches
a terminal condition — every item done or abandoned, a recorded stop, an outstanding paused/waiting
hold **while no other item can make progress**, or a watchdog stop — and SHALL NOT invoke,
discover, read, or depend on an externally installed goal-loop skill on any execution path. An
outstanding paused/waiting hold SHALL be a terminal condition **only when no non-done item can make
progress**: while at least one other item is schedulable, the supervisor SHALL exclude each held
item from the executable frontier and continue dispatching the remaining schedulable items rather
than halting the run. The supervisor SHALL NOT create a second ledger, lock, run-id namespace, or
run directory; every durable write it makes SHALL be issued through the engine into the single
authoritative run directory.

#### Scenario: A locked run advances to completion in-repo

- **WHEN** the supervisor is attached to a compiled, locked run whose items are all executable
- **THEN** it SHALL execute the items in dependency order and reach a terminal condition
- **AND** through the injected seams no subprocess invocation of an external goal-loop skill or its
  state CLI SHALL be recorded on any path

#### Scenario: The run halts at the first terminal condition

- **WHEN** a cycle records a stop, or leaves no active item remaining and no schedulable item, or
  reaches an outstanding paused/waiting hold while no other item can make progress
- **THEN** the supervisor SHALL stop cycling and report the terminal condition
- **AND** it SHALL NOT create a second ledger, lock, run-id, or run directory

#### Scenario: A hold alongside a schedulable item does not halt the run

- **WHEN** a cycle leaves one item in an outstanding paused/waiting hold while another item is
  still schedulable
- **THEN** the supervisor SHALL exclude the held item from the executable frontier and continue
  dispatching the schedulable item
- **AND** it SHALL NOT treat the hold as a terminal condition for the run

#### Scenario: Only one item is active at a time

- **WHEN** the supervisor selects work for a cycle from a contract whose `max_active_items` is one
- **THEN** it SHALL dispatch at most one item in that cycle
- **AND** it SHALL respect the contract's dependency ordering when choosing which item
