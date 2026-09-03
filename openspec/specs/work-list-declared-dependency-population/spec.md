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

### Requirement: Hard waits SHALL be admitted only for open prerequisites on the current work-list selector

Work-list population SHALL apply a deterministic **hard-wait admission** step after raw
declared prerequisites are unioned from authoritative sources, and before `depends_on` /
`external_depends_on` partition and contract compilation. A candidate prerequisite id for a
depender SHALL be admitted as a hard wait only when **both** are true:

1. The target issue is a member of the **current work-list / train selector snapshot** (the
   same set of issue ids that the run is compiling — milestone membership, explicit
   work-list, label/roadmap-slice resolution, or equivalent selector), and
2. The target issue is observed **open** (not closed-as-completed, not closed-as-not-planned,
   not merged-closed) at admission time through the injectable discovery / observation seam.

An admitted hard wait SHALL flow into the existing in-snapshot / external partition rules
exactly as today's raw declared edge does when the target is in-snapshot and open. A
non-admitted candidate SHALL **not** appear on the compiled item's `depends_on` or
`external_depends_on` gates. Population SHALL NOT invent ordering from LLM inference, list
position, or shared-file heuristics. Unit tests SHALL inject fakes for selector membership
and open/closed observation and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Open on-selector Depends on remains a hard wait

- **WHEN** work-list snapshot contains issues `647` and `599`
- **AND** issue `647` declares `Depends on: #599` (or equivalent phrase form)
- **AND** issue `599` is observed open
- **THEN** the compiled contract item for `647` SHALL include `599` in in-snapshot
  `depends_on`

#### Scenario: Open off-selector Depends on is not a hard wait

- **WHEN** work-list snapshot contains issue `838` but not issue `822`
- **AND** issue `838` declares `Depends on: #822` or a bare `#822` under `## Dependencies`
- **AND** issue `822` is observed open
- **THEN** the compiled contract item for `838` SHALL NOT include `822` on `depends_on` or
  `external_depends_on`
- **AND** an `ignored_dep` record for depender `838` and target `822` SHALL be produced with
  reason indicating the target is not on the selector

#### Scenario: Closed or merged on- or off-selector declaration is not a hard wait

- **WHEN** issue `A` declares a dependency on `#B` via an authoritative lexical source
- **AND** issue `B` is observed closed (completed or not-planned) or satisfied via a merged
  linked PR under the observation seam used for admission
- **THEN** the compiled contract item for `A` SHALL NOT gate on `B` as a hard wait
- **AND** an `ignored_dep` record SHALL name `B` and a closed/merged-class reason
- **AND** `A` SHALL remain eligible for scheduling subject to other gates

#### Scenario: Soft Related-only reference never becomes a hard wait

- **WHEN** issue `A` mentions `#B` only under a soft Related / see-also section with no
  dependency phrase
- **AND** lexical observation uses the shared grammar
- **THEN** `B` SHALL NOT appear in `A`'s raw declared set
- **AND** no hard wait on `B` SHALL be compiled for `A`

### Requirement: Non-admitted declarations SHALL be logged as ignored_dep with a stable reason

When hard-wait admission drops a candidate prerequisite, population SHALL emit a structured
`ignored_dep` observation (event field, discovery result field, or equivalent durable run
telemetry) that includes at least: depender issue id, ignored target id, and a stable
machine-readable reason code. Reason codes SHALL distinguish at least:

- `not_on_selector` — target not in the current work-list / train snapshot
- `closed` — target observed closed (completed or not-planned class as applicable)
- `not_open` — target not open for any other observed reason used by admission

Admission MUST NOT require rewriting the issue body. Operators MAY leave stale
`## Dependencies` prose in place; the engine ignores non-admitted targets without a
mid-ship body edit.

#### Scenario: Off-selector ignore is auditable

- **WHEN** issue `839` declares `#822` under `## Dependencies` and `822` is not on the
  train selector
- **THEN** compilation SHALL produce an `ignored_dep` for `839`→`822` with reason
  `not_on_selector` (or an equivalent documented alias)
- **AND** the run SHALL NOT stop solely because that reference existed in the body

#### Scenario: Body rewrite is not required

- **WHEN** a non-admitted soft or stale dependency reference remains in the issue body
- **THEN** hard-wait admission SHALL still ignore it for scheduling
- **AND** the engine SHALL NOT require an operator or Hermes body edit to clear the gate

### Requirement: Train SHALL consume the shared work-list population path rather than a private graph

Train SHALL resolve declared dependencies for its frozen selected issue set through the
same declared-dependency population path that loop work-list compile uses, including the
shared lexical grammar, native `blockedBy` observation, optional roadmap-declared edges,
source-status classification, and hard-wait admission. Train `--issues` and `--milestone`
selectors SHALL not retain a private title/body parser that can omit native or roadmap
edges the shared path would admit. Resume of an already-initialized train run SHALL keep
the graph resolved at that train's start; a later train invocation SHALL discover afresh.

#### Scenario: Train explicit list uses the shared population path

- **WHEN** `pipeline train --issues 1322,1323` resolves its work list
- **AND** native discovery fully observes that 1323 is blocked by 1322
- **THEN** the admitted declared set for 1323 SHALL include 1322
- **AND** train SHALL NOT drop that edge because it parsed only title and body

#### Scenario: Train milestone list uses the shared population path

- **WHEN** `pipeline train --milestone vX.Y.Z` resolves freeze-eligible issues that include
  a native `blockedBy` pair
- **AND** all enabled discovery sources are fully observed
- **THEN** the admitted train graph SHALL carry that native edge the same way an explicit
  `--issues` list of those same ids would

#### Scenario: Hard-wait admission still drops closed and off-selector targets

- **WHEN** train discovery unions a native or lexical candidate `B` for depender `A`
- **AND** `B` is closed, merged, or not on the frozen selected set
- **THEN** `B` SHALL NOT remain an admitted hard wait on `A`
- **AND** an `ignored_dep` record SHALL name `A`, `B`, and the stable reason
- **AND** `A` SHALL remain eligible subject to other gates
