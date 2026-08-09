## ADDED Requirements

### Requirement: Each authoritative discovery source observation SHALL report a closed status vocabulary

Pipeline SHALL classify each enabled authoritative discovery source observation, when it
discovers declared dependencies for a work-list compile, as exactly one of:

- `observed-empty` — the source was fully observed and contributed zero edges for its
  scope
- `observed-with-edges` — the source was fully observed and contributed one or more edges
- `unavailable` or `incomplete` — the source could not be fully observed (for example
  total failure, null unobservable result, truncated pagination, or partial/truncated
  response)

An `unavailable` or `incomplete` observation SHALL NEVER be represented or recorded as
`observed-empty`. Source load failure, truncation past a safety bound without exhaustion,
and missing required issue text when that source is enabled SHALL be classified as
unavailable or incomplete, not as empty.

#### Scenario: Successful empty observation is observed-empty

- **WHEN** GitHub native `blockedBy` is fully read for an issue and returns zero blockers
- **THEN** that source observation SHALL be reported as `observed-empty`
- **AND** SHALL NOT be reported as unavailable or incomplete

#### Scenario: Successful non-empty observation is observed-with-edges

- **WHEN** lexical body parsing fully observes an issue body that declares `#607`
- **THEN** that source observation SHALL be reported as `observed-with-edges`

#### Scenario: Total source failure is not observed-empty

- **WHEN** an enabled native dependency read throws or returns an unobservable null for an
  issue during fresh discovery
- **THEN** that source observation SHALL be reported as `unavailable` or `incomplete`
- **AND** SHALL NOT be recorded as `observed-empty`

#### Scenario: Truncated or partial response is incomplete

- **WHEN** an enabled paginated native dependency read hits a safety bound without
  exhausting pages, or returns a truncated payload
- **THEN** that source observation SHALL be reported as `incomplete` (or `unavailable`)
- **AND** SHALL NOT be treated as a complete empty or complete edge set

### Requirement: Fresh multi-item or factory-owned run admission SHALL refuse incomplete discovery

Pipeline SHALL refuse admission with a typed, actionable result that names the incomplete
source and enough scope to act (issue id and/or list-level source) when it initializes a
**fresh** durable run that is multi-item (resolved snapshot contains two or more issues) or
factory-owned and any **enabled** authoritative discovery source observation for that
compile is `unavailable` or `incomplete`. Pipeline SHALL NOT initialize a run contract or
ledger for that refused attempt. Successfully observed edges from other sources SHALL NOT
override the refuse when any enabled source remains incomplete.

#### Scenario: Incomplete native source blocks multi-item init

- **WHEN** a fresh multi-item work-list compile enables native `blockedBy` discovery
- **AND** that source is incomplete for at least one snapshot issue
- **THEN** compile/admission SHALL fail with a typed actionable result
- **AND** no run contract or ledger SHALL be created for that attempt

#### Scenario: Incomplete issue text blocks factory-owned init

- **WHEN** a fresh factory-owned multi-item compile cannot fully observe required issue
  title/body text for a snapshot issue
- **THEN** admission SHALL be refused
- **AND** no run contract or ledger SHALL be initialized

#### Scenario: Fully observed empty sources still admit independent items

- **WHEN** every enabled authoritative source for a fresh multi-item compile is fully
  observed and all are `observed-empty` for every item
- **THEN** admission MAY proceed
- **AND** compiled items SHALL remain independent (`depends_on` / `external_depends_on`
  empty) rather than inventing edges

### Requirement: Accepted contract and audit output SHALL identify edge source and observation identity

When a fresh compile is accepted, the accepted contract and the compile audit output SHALL
identify the contributing authoritative source of every dependency edge used in the
contract (at least distinguishing lexical body/title, native blocked-by, and roadmap-
declared sources when each contributes). They SHALL also record the observation identity
and status used during compilation for each enabled source scope so an operator can audit
why admission succeeded. Resume of an existing durable run SHALL preserve the accepted
graph and SHALL NOT rewrite edge sources by re-discovery.

#### Scenario: Accepted edge carries source attribution

- **WHEN** issue `608` receives prerequisite `607` only from lexical body text and the
  compile is accepted
- **THEN** the accepted contract or audit trail SHALL identify that edge's source as the
  lexical declaration source

#### Scenario: Observation identity is recorded for the compile

- **WHEN** a fresh multi-item compile is accepted after full observation of enabled sources
- **THEN** the contract or audit output SHALL record each enabled source's observation
  status and an observation identity for that compile decision

#### Scenario: Resume does not rewrite accepted graph provenance

- **WHEN** a durable run already exists on disk and is resumed
- **THEN** Pipeline SHALL NOT re-discover dependencies and overwrite the accepted edge set
  or edge source attribution as part of ordinary resume

### Requirement: Source disagreement among fully observed sources SHALL union edges without inventing independence

Pipeline SHALL union the successfully observed edges for a depender when two enabled
sources are both fully observed and one contributes an edge the other does not. Full
observation of an empty source alongside a non-empty source SHALL NOT drop the non-empty
source's edges and SHALL NOT be treated as discovery failure.

#### Scenario: Lexical edge retained when native is observed-empty

- **WHEN** lexical text declares `#607` for depender `608`
- **AND** native `blockedBy` is fully observed empty for `608`
- **THEN** `607` SHALL remain in `608`'s raw declared dependencies
- **AND** admission SHALL NOT fail solely because the sources disagree on emptiness

#### Scenario: Tests cover disagreement and partial failure

- **WHEN** unit tests exercise discovery source status
- **THEN** they SHALL cover source disagreement between fully observed sources, partial or
  truncated responses, and total source failure
- **AND** they SHALL inject fakes with zero real network, git, and subprocess calls
