## MODIFIED Requirements

### Requirement: The ledger SHALL admit only the defined item transition graph

The engine SHALL maintain a per-item state with a defined transition graph and SHALL refuse
any transition not on that graph, naming the current and requested states. The graph SHALL
be: from pending to in-progress, blocked, or abandoned; from in-progress to implemented,
blocked, paused, waiting, or abandoned; from implemented to PR-opened, blocked, or abandoned;
from PR-opened to ready, blocked, or abandoned; from ready to merged, blocked, or abandoned;
from merged to released or deployed; from released to deployed; from blocked to in-progress or
abandoned; from paused to in-progress or abandoned; and from waiting to in-progress or
abandoned. Deployed and abandoned SHALL be terminal with no outgoing transitions. `paused` and
`waiting` SHALL be non-terminal, non-failure holds: entering either SHALL NOT require a theme,
SHALL NOT charge a recovery budget, and SHALL NOT increment the consecutive-blocked count.
Every accepted transition SHALL append a history entry recording the time, the from and to
states, the acting engine, and any supplied theme, evidence, or note.

#### Scenario: Every legal edge is accepted and every illegal edge refused

- **WHEN** each ordered pair of item states is attempted as a transition
- **THEN** exactly the pairs on the defined graph SHALL be accepted
- **AND** every other pair SHALL be refused as a validation error naming both states

#### Scenario: Terminal states have no outgoing transitions

- **WHEN** a transition is attempted out of deployed or abandoned
- **THEN** it SHALL be refused
- **AND** the item's state SHALL be unchanged

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

### Requirement: The engine SHALL refuse a transition through an authority gate the contract does not grant

The engine SHALL derive four authority grants — opening a pull request, merging, releasing,
and deploying — from the discovery's explicit grants at compile time, and SHALL map each to the
transition it guards. A gated transition SHALL be authorized only when the compiled contract
grants that gate, or when a matching audited scoped authority amendment (capability
`durable-pause-and-authority`) covers that exact gate for that transition's item; a scoped
amendment SHALL widen authority only for the exact gate and scope it names and SHALL NOT widen
any other gate or item. A transition through a gate that neither a compile-time grant nor a
matching amendment authorizes SHALL be refused with an authority-class failure stating that
broad objectives do not grant gates and that the run must stop and report. No objective text,
selector, or ambient later input SHALL widen a grant — only a compile-time grant or an audited
scoped amendment SHALL do so.

#### Scenario: An ungranted gate refuses the transition

- **WHEN** a transition to a gated state is attempted and neither a compile-time grant nor a
  matching amendment authorizes that gate
- **THEN** it SHALL be refused with an authority-class failure
- **AND** the item's state SHALL be unchanged

#### Scenario: Objective text does not widen a grant

- **WHEN** discovery declares a broad objective but grants no authority and no amendment exists
- **THEN** the compiled contract SHALL record every gate as not granted
- **AND** every gated transition SHALL be refused

#### Scenario: An unknown grant name is refused at compile time

- **WHEN** discovery declares an authority grant outside the four defined names
- **THEN** compilation SHALL fail as a validation error naming the unknown grant

#### Scenario: A matching audited amendment authorizes the gate

- **WHEN** no compile-time grant covers a gate but a matching audited scoped amendment covers
  that gate for the transitioning item, and directly verified evidence is supplied
- **THEN** the gated transition SHALL be authorized
