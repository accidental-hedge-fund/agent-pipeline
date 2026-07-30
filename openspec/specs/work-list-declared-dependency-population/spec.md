# work-list-declared-dependency-population Specification

## Purpose
TBD - created by archiving change work-list-declared-dependency-population. Update Purpose after archive.
## Requirements
### Requirement: Work-list compilation SHALL populate declared dependencies before contract item compilation

Work-list compilation SHALL resolve each item's **declared** prerequisite issue ids from
authoritative sources and pass those declarations into `compileContractItems` (or an
equivalent partition that preserves the same in-snapshot / external split) whenever
Pipeline compiles a durable run from a resolved work-list of issue ids — whether that list
originated from a milestone, label, roadmap-slice, or explicit work-list selector. It SHALL
NOT hardcode an empty `depends_on` list for every item when declarations exist. An item with
no declaration from any authoritative source SHALL compile with empty `depends_on` and empty
`external_depends_on` (independent by default). Population SHALL NOT invent prerequisites
from shared files, ranking heuristics, AI inference, or list position alone.

#### Scenario: An in-snapshot body declaration becomes depends_on

- **WHEN** a work-list containing issues `607` and `608` is compiled
- **AND** issue `608` declares a dependency on `#607` via an authoritative source
- **THEN** the compiled contract item for `608` SHALL include `607` in its in-snapshot
  `depends_on`
- **AND** `607` SHALL NOT appear on `608`'s `external_depends_on`

#### Scenario: An out-of-snapshot declaration becomes external_depends_on

- **WHEN** a work-list containing only issue `608` is compiled
- **AND** issue `608` declares a dependency on `#607`
- **THEN** the compiled contract item for `608` SHALL record `607` on
  `external_depends_on`
- **AND** `607` SHALL be absent from `608`'s in-snapshot `depends_on`

#### Scenario: No declaration yields independent items

- **WHEN** a work-list of issues is compiled and no authoritative source declares a
  dependency for any item
- **THEN** every compiled item SHALL have empty `depends_on` and empty
  `external_depends_on`

#### Scenario: List position alone is not a dependency

- **WHEN** a work-list is compiled in any input order and no authoritative source declares
  edges among its issues
- **THEN** the compiler SHALL NOT invent `depends_on` edges from that order

### Requirement: Declared dependency sources SHALL be the documented authoritative set and SHALL be unioned

Pipeline SHALL treat the following as authoritative declaration sources for work-list
population (v1) and SHALL **union** (deduplicate) prerequisite ids contributed by any of
them for a given depender:

1. **Lexical body/title conventions** — deterministic parse of the issue title and body for
   dependency phrases (`depends on`, `requires`, `blocked by`, `needs` followed by `#N`)
   and for `#N` references under a `## Dependency` or `## Dependencies` heading section.
2. **GitHub native issue dependencies** — same-repo issues that GitHub records as blocking
   the depender (e.g. GraphQL `blockedBy`), when observable through the discovery seam.
3. **Declared roadmap / slice edges** — issue-level prerequisite edges already present in
   the roadmap or slice graph when that graph is available to the compile context.

Self-references SHALL be ignored. A source that is unavailable or fails to load for an
issue SHALL contribute no edges for that source (fail closed toward independent for that
source), without fabricating substitutes. Discovery of issue text and native relationships
SHALL run through an injectable dependency seam so unit tests perform no real network, git,
or subprocess calls.

#### Scenario: Body section declaration is recognized

- **WHEN** an issue body contains a `## Dependency` section that references `#607`
- **AND** the depender is compiled into a work-list
- **THEN** `607` SHALL be included in that item's raw declared dependencies before partition

#### Scenario: Phrase declaration is recognized

- **WHEN** an issue body or title contains the phrase `Depends on #607` (case-insensitive)
- **THEN** `607` SHALL be included in that item's raw declared dependencies before partition

#### Scenario: Native blockedBy is recognized

- **WHEN** GitHub records that issue `608` is blocked by issue `607`
- **AND** discovery observes that relationship
- **THEN** `607` SHALL be included in `608`'s raw declared dependencies before partition

#### Scenario: Sources are unioned without fabrication

- **WHEN** the body declares `#607` and native blockedBy also lists `609`
- **THEN** both `607` and `609` SHALL appear in the raw declared set for that item
- **AND** no other issue id SHALL be added without a source declaration

#### Scenario: Discovery is seam-injected under test

- **WHEN** unit tests exercise work-list dependency population
- **THEN** they SHALL inject fakes for issue text and native dependency reads
- **AND** the test process SHALL perform zero real network, git, and subprocess calls for
  those reads

### Requirement: All work-list selectors SHALL share one population path

Milestone, label, roadmap-slice, and explicit work-list selectors SHALL resolve to issue ids
and then use the **same** declared-dependency population path before contract compilation.
No selector type SHALL retain a hardcode that forces every item to empty `depends_on` while
other selectors populate declarations. Resume of an already-initialized run SHALL keep the
on-disk contract (no silent mid-run rewrite of dependency edges); fresh initialization of a
run that does not yet exist SHALL populate declarations at compile time.

#### Scenario: Milestone-resolved list is populated

- **WHEN** a milestone selector resolves to a set of issue ids that include a declared
  dependency pair
- **THEN** the freshly compiled contract for that run SHALL carry the corresponding
  `depends_on` / `external_depends_on` edges

#### Scenario: Explicit work-list is populated

- **WHEN** an explicit work-list selector is compiled with a declared dependency among its
  issues
- **THEN** the compiled contract SHALL carry that edge the same way a milestone-resolved
  list would

#### Scenario: Resume does not rewrite existing contract edges

- **WHEN** a run already exists on disk and is resumed
- **THEN** Pipeline SHALL NOT re-discover and overwrite that run's contract dependency edges
  as part of ordinary resume

### Requirement: Population SHALL preserve deterministic cycle-checked compilation

Population SHALL leave compilation subject to the `durable-loop-engine` dependency-ordering
rules after raw declarations are collected: deterministic topological order for in-snapshot
edges, refusal of duplicate item ids, refusal of in-snapshot cycles as a validation failure,
and preservation of out-of-snapshot ids on `external_depends_on` without participating in
cycle detection. Population SHALL NOT weaken those rules.

#### Scenario: In-snapshot cycle still fails compile

- **WHEN** discovered declarations form a cycle among snapshot items
- **THEN** compilation SHALL fail as a validation error naming the cycle
- **AND** no run SHALL be initialized from that compile attempt

#### Scenario: Repeated compile of the same declarations is stable

- **WHEN** the same issue list and same declared edge set are compiled repeatedly
- **THEN** every item SHALL appear after its in-snapshot dependencies
- **AND** the resulting item order SHALL be identical on every compilation

