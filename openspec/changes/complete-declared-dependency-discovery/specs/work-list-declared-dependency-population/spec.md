## ADDED Requirements

### Requirement: Work-list lexical discovery SHALL use the shared multi-reference grammar

Work-list declared-dependency population SHALL obtain lexical prerequisite ids only through
the shared `declared-dependency-grammar` export. Phrase declarations that list multiple
issue references (including punctuated forms such as `Depends on: #12, #13` and
`Depends on #12 and #13`) SHALL contribute every listed prerequisite to the raw declared
set before in-snapshot / external partition. Work-list population SHALL NOT keep a private
phrase regular expression that can drop trailing references.

#### Scenario: Multi-reference body declaration is fully preserved

- **WHEN** issue `900` body declares `Depends on: #899, #662` (or equivalent multi-reference
  form)
- **AND** a work-list containing `900` is compiled with successful lexical observation
- **THEN** both `899` and `662` SHALL appear in `900`'s raw declared dependencies before
  partition

#### Scenario: In-snapshot and external partition still apply after multi-ref parse

- **WHEN** a work-list snapshot contains `899` and `900` but not `662`
- **AND** `900` declares both `899` and `662`
- **THEN** the compiled contract item for `900` SHALL include `899` in in-snapshot
  `depends_on`
- **AND** SHALL include `662` on `external_depends_on`

## MODIFIED Requirements

### Requirement: Declared dependency sources SHALL be the documented authoritative set and SHALL be unioned

Pipeline SHALL treat the following as authoritative declaration sources for work-list
population (v1) and SHALL **union** (deduplicate) prerequisite ids contributed by any of
them for a given depender when those sources are successfully observed:

1. **Lexical body/title conventions** — deterministic parse via the shared
   `declared-dependency-grammar` of the issue title and body for dependency phrases
   (`depends on`, `requires`, `blocked by`, `needs`, including multi-reference lists) and
   for `#N` references under a `## Dependency` or `## Dependencies` heading section.
2. **GitHub native issue dependencies** — same-repo issues that GitHub records as blocking
   the depender (e.g. GraphQL `blockedBy`), when fully observable through the discovery
   seam.
3. **Declared roadmap / slice edges** — issue-level prerequisite edges already present in
   the roadmap or slice graph when that graph is available and fully observed by the
   compile context.

Self-references SHALL be ignored. Each enabled source observation SHALL report status per
`dependency-discovery-source-status` (`observed-empty`, `observed-with-edges`, or
`unavailable`/`incomplete`). An unavailable or incomplete source SHALL NOT be treated as
observed-empty and SHALL NOT silently widen scheduling permission for a fresh multi-item
or factory-owned run (see `dependency-discovery-source-status` refuse rules). When a fresh
compile is refused for incomplete discovery, no raw edge set SHALL be accepted as a run
contract. Discovery of issue text and native relationships SHALL run through an injectable
dependency seam so unit tests perform no real network, git, or subprocess calls.

#### Scenario: Body section declaration is recognized

- **WHEN** an issue body contains a `## Dependency` section that references `#607`
- **AND** the depender is compiled into a work-list with successful lexical observation
- **THEN** `607` SHALL be included in that item's raw declared dependencies before partition

#### Scenario: Phrase declaration is recognized

- **WHEN** an issue body or title contains the phrase `Depends on #607` (case-insensitive)
- **AND** lexical observation succeeds
- **THEN** `607` SHALL be included in that item's raw declared dependencies before partition

#### Scenario: Multi-reference phrase declaration is fully recognized

- **WHEN** an issue body contains `Depends on #12 and #13` (case-insensitive)
- **AND** lexical observation succeeds
- **THEN** both `12` and `13` SHALL be included in that item's raw declared dependencies
  before partition

#### Scenario: Native blockedBy is recognized

- **WHEN** GitHub records that issue `608` is blocked by issue `607`
- **AND** discovery fully observes that relationship
- **THEN** `607` SHALL be included in `608`'s raw declared dependencies before partition

#### Scenario: Sources are unioned without fabrication

- **WHEN** the body declares `#607` and native blockedBy also lists `609`
- **AND** both sources are fully observed
- **THEN** both `607` and `609` SHALL appear in the raw declared set for that item
- **AND** no other issue id SHALL be added without a source declaration

#### Scenario: Unavailable source does not count as empty for multi-item admission

- **WHEN** a fresh multi-item work-list compile enables native blockedBy discovery
- **AND** that source is unavailable or incomplete for an issue in the snapshot
- **THEN** Pipeline SHALL NOT treat that source as observed-empty
- **AND** admission SHALL refuse per `dependency-discovery-source-status` rather than
  compiling as if no native dependencies existed

#### Scenario: Discovery is seam-injected under test

- **WHEN** unit tests exercise work-list dependency population
- **THEN** they SHALL inject fakes for issue text and native dependency reads
- **AND** the test process SHALL perform zero real network, git, and subprocess calls for
  those reads

### Requirement: All work-list selectors SHALL share one population path

Milestone, label, roadmap-slice, and explicit work-list selectors SHALL resolve to issue ids
and then use the **same** declared-dependency population path before contract compilation,
including the shared lexical grammar and shared source-status handling. No selector type
SHALL retain a hardcode that forces every item to empty `depends_on` while other selectors
populate declarations, and no selector type SHALL use a private multi-reference-incomplete
parser. Resume of an already-initialized run SHALL keep the on-disk contract (no silent
mid-run rewrite of dependency edges); fresh initialization of a run that does not yet exist
SHALL populate declarations at compile time only when discovery observations satisfy
admission rules.

#### Scenario: Milestone-resolved list is populated

- **WHEN** a milestone selector resolves to a set of issue ids that include a declared
  dependency pair
- **AND** all enabled discovery sources are fully observed
- **THEN** the freshly compiled contract for that run SHALL carry the corresponding
  `depends_on` / `external_depends_on` edges

#### Scenario: Explicit work-list is populated

- **WHEN** an explicit work-list selector is compiled with a declared dependency among its
  issues
- **AND** all enabled discovery sources are fully observed
- **THEN** the compiled contract SHALL carry that edge the same way a milestone-resolved
  list would

#### Scenario: Resume does not rewrite existing contract edges

- **WHEN** a run already exists on disk and is resumed
- **THEN** Pipeline SHALL NOT re-discover and overwrite that run's contract dependency edges
  as part of ordinary resume
