## MODIFIED Requirements

### Requirement: Dependency ordering SHALL be deterministic and SHALL reject cycles

The engine SHALL order snapshot items so that every item follows the items it depends on,
breaking ties by a documented total order so repeated compilations of the same snapshot
produce an identical sequence. Duplicate item ids SHALL be refused. A dependency cycle among
in-snapshot items SHALL be refused as a validation failure. A declared dependency on an item
**outside** the snapshot SHALL be **preserved as an external dependency** — recorded on the item in
a dedicated `external_depends_on` list rather than dropped — because such a dependency names real
prerequisite work the run cannot itself schedule. An external dependency SHALL NOT constrain the
ordering and SHALL NOT participate in cycle detection (the snapshot's schedulable world is the
in-snapshot `depends_on` graph); its verification and its effect on eligibility are governed by the
`durable-run-dependency-integrity` capability.

#### Scenario: Ordering is dependency-respecting and stable

- **WHEN** a snapshot with declared dependencies is compiled repeatedly
- **THEN** every item SHALL appear after all of its in-snapshot dependencies
- **AND** the resulting order SHALL be identical on every compilation

#### Scenario: A dependency cycle is refused

- **WHEN** the snapshot's in-snapshot dependencies form a cycle
- **THEN** compilation SHALL fail as a validation error naming the cycle
- **AND** no run SHALL be initialized

#### Scenario: Duplicate item ids are refused

- **WHEN** the snapshot contains the same item id twice
- **THEN** compilation SHALL fail as a validation error

#### Scenario: An out-of-snapshot dependency is preserved as an external dependency

- **WHEN** an item declares a dependency on an id not present in the snapshot
- **THEN** compilation SHALL succeed
- **AND** that id SHALL be recorded on the item's `external_depends_on` list and absent from its
  in-snapshot `depends_on`
- **AND** that dependency SHALL NOT constrain the ordering and SHALL NOT be considered when detecting
  cycles

### Requirement: The ledger SHALL admit only the defined item transition graph

The engine SHALL maintain a per-item state with a defined transition graph and SHALL refuse
any transition not on that graph, naming the current and requested states. The graph SHALL
be: from pending to in-progress, blocked, abandoned, or skipped; from in-progress to implemented,
blocked, paused, waiting, or abandoned; from implemented to PR-opened, blocked, or abandoned;
from PR-opened to ready, blocked, or abandoned; from ready to merged, blocked, or abandoned;
from merged to released or deployed; from released to deployed; from blocked to in-progress,
abandoned, or skipped; from paused to in-progress or abandoned; and from waiting to in-progress or
abandoned. Deployed, abandoned, and skipped SHALL be terminal with no outgoing transitions. `skipped`
SHALL be reachable only from pending or blocked and only via dependency propagation (capability
`durable-run-dependency-integrity`) — never as a caller-requested transition. `paused` and
`waiting` SHALL be non-terminal, non-failure holds: entering either SHALL NOT require a theme,
SHALL NOT charge a recovery budget, and SHALL NOT increment the consecutive-blocked count.
Every accepted transition SHALL append a history entry recording the time, the from and to
states, the acting engine, and any supplied theme, evidence, or note.

#### Scenario: Every legal edge is accepted and every illegal edge refused

- **WHEN** each ordered pair of item states is attempted as a transition
- **THEN** exactly the pairs on the defined graph SHALL be accepted
- **AND** every other pair SHALL be refused as a validation error naming both states

#### Scenario: Terminal states have no outgoing transitions

- **WHEN** a transition is attempted out of deployed, abandoned, or skipped
- **THEN** it SHALL be refused
- **AND** the item's state SHALL be unchanged

#### Scenario: Skipped is reachable only from pending or blocked

- **WHEN** a transition to `skipped` is attempted
- **THEN** it SHALL be accepted only from `pending` or `blocked`
- **AND** a transition to `skipped` from any other state SHALL be refused as a validation error

#### Scenario: A transition to blocked requires a theme

- **WHEN** a transition to blocked supplies no theme
- **THEN** it SHALL be refused as a validation error
- **AND** when a theme is supplied it SHALL be recorded both on the history entry and as the
  item's current blocked theme

#### Scenario: Paused and waiting are admitted from in-progress and resume in place

- **WHEN** an in-progress item transitions to `paused` or `waiting` and later back to
  `in_progress`
- **THEN** both transitions SHALL be accepted
- **AND** each SHALL append a history entry naming the from and to states and the acting engine

#### Scenario: Entering a hold neither charges budget nor counts a block

- **WHEN** an in-progress item transitions to `paused` or `waiting`
- **THEN** no recovery budget SHALL be decremented
- **AND** the consecutive-blocked count SHALL be unchanged

#### Scenario: History records the acting engine

- **WHEN** a transition is accepted
- **THEN** the history entry SHALL record the engine of the lock holder that performed it
