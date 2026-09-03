## ADDED Requirements

### Requirement: Train SHALL resolve one shared discovery graph before order, plan, frontier, or independence decisions

Train SHALL obtain declared dependencies for the frozen selected work-list from the same
authoritative discovery contract used by durable loop work-list compile. That contract
SHALL union lexical body/title declarations, GitHub-native same-repo `blockedBy` edges, and
enabled roadmap-declared edges, then apply hard-wait admission. Train SHALL use that one
admitted graph for issue order, dry-run planning, base-eligible frontier computation, merge
eligibility, and independent-sibling continuation. Train SHALL NOT maintain a second
lexical-only declared-dependency graph and SHALL NOT invent a train-local parser or GitHub
query shape for those sources. A missing or unknown admitted edge SHALL fail closed as a
code dependency. List order and bare related-work references SHALL NOT become dependencies.

#### Scenario: Native blockedBy enters the train graph

- **WHEN** a train selects issues `1322` and `1323`
- **AND** GitHub-native discovery fully observes that `1323` is blocked by `1322`
- **AND** neither issue body declares a lexical `Depends on` edge
- **THEN** the train graph SHALL include `1323` depends on `1322`
- **AND** `1323` SHALL NOT be treated as independent of `1322`

#### Scenario: Lexical, native, and enabled roadmap edges are unioned

- **WHEN** issue `B` lexically declares `Depends on: #A`
- **AND** native `blockedBy` fully observes that `B` is blocked by `C`
- **AND** an enabled roadmap source fully observes `B` depends on `D`
- **AND** `A`, `C`, and `D` are open members of the selected work-list
- **THEN** the admitted train graph for `B` SHALL include `A`, `C`, and `D`
- **AND** train SHALL NOT drop any of those sources because another source omitted them

#### Scenario: Train does not use a private lexical-only graph

- **WHEN** train orders issues, computes a frontier, or tests independence of held items
- **THEN** those decisions SHALL consume the shared discovery result
- **AND** they SHALL NOT re-parse title and body as the sole declared-dependency source

---

### Requirement: A fresh multi-item train SHALL refuse incomplete discovery before run-store init or advance

Train SHALL refuse a **fresh** multi-item invocation with a typed, actionable result that
names the incomplete source and enough scope to act (issue id and/or list-level source)
when any **enabled** authoritative discovery source observation is `unavailable` or
`incomplete`. Train SHALL NOT create a train run store, SHALL NOT emit `train_run_handoff`,
SHALL NOT invoke an advance wave, and SHALL NOT invoke the merge surface for that refused
attempt. Successfully observed edges from other sources SHALL NOT override the refuse.
Fully observed empty sources SHALL still admit independent items rather than inventing
edges. A single-item non-factory train SHALL follow the same incomplete-source observation
rules as a single-item non-factory loop compile (observations recorded; no hard refuse
unless factory-owned or otherwise forced).

#### Scenario: Incomplete native source blocks multi-item train before store init

- **WHEN** `pipeline train --issues 1322,1323` is a fresh multi-item invocation
- **AND** native `blockedBy` discovery is `unavailable` or `incomplete` for either issue
- **THEN** the command SHALL exit non-zero with a typed result naming that native source
- **AND** it SHALL NOT create `.agent-pipeline/runs/train-*/`
- **AND** it SHALL NOT invoke an advance wave or the merge surface

#### Scenario: Fully observed empty native source still admits independents

- **WHEN** a fresh multi-item train fully observes native `blockedBy` as empty for every
  selected issue
- **AND** lexical and enabled roadmap sources are also fully observed
- **THEN** admission MAY proceed
- **AND** items with no admitted edge SHALL remain independent rather than inventing edges

---

## MODIFIED Requirements

### Requirement: Train independence SHALL exclude direct and transitive dependents of held items

A remaining selected item SHALL count as **independent** of the held set when it has no
direct or transitive admitted declared-dependency path to any held item. Direct and
transitive dependents of a held item SHALL themselves be held with terminal
`dependency-skipped`. They SHALL NOT enter an advance wave and SHALL NOT be merged while
that ancestor remains held.

Independence SHALL be computed from the **admitted** shared discovery graph resolved at
train start for the frozen selected set: lexical body/title declarations, GitHub-native
`blockedBy` edges, and enabled roadmap-declared edges after hard-wait admission. A lexical
`Depends on: #N` phrase is one source of that graph, not the only source. A missing or
unknown admitted edge SHALL fail closed as a code dependency, as today. A remaining item
that a held item depends on (a prerequisite of the held item) SHALL NOT be skipped solely
because of that reverse edge. Closed, merged, and out-of-selector references that hard-wait
admission ignores SHALL NOT create a skip or a deadlock.

#### Scenario: Direct dependent is dependency-skipped

- **WHEN** merge-mode train holds item 268
- **AND** item 270 declares `Depends on: #268`
- **THEN** the train SHALL record 270 as `dependency-skipped`
- **AND** SHALL NOT advance or merge 270 while 268 remains held

#### Scenario: Transitive dependent is dependency-skipped

- **WHEN** merge-mode train holds item 268
- **AND** item 270 declares `Depends on: #268`
- **AND** item 271 declares `Depends on: #270`
- **THEN** the train SHALL record 271 as `dependency-skipped`
- **AND** SHALL NOT advance or merge 271 while 268 remains held

#### Scenario: Independent peer of a held item still runs

- **WHEN** merge-mode train holds item 268
- **AND** item 267 has no direct or transitive `Depends on` path to 268
- **THEN** 267 SHALL remain eligible to advance and, if it reaches ready-to-deploy, to merge
- **AND** 267 SHALL NOT be recorded as `dependency-skipped`

#### Scenario: Prerequisite of a held item is not skipped for the reverse edge

- **WHEN** item 268 declares `Depends on: #267` and 268 is held
- **AND** 267 has no `Depends on` path to 268 and is not yet finished
- **THEN** 267 SHALL remain eligible to advance
- **AND** SHALL NOT be recorded as `dependency-skipped` solely because 268 depends on it

#### Scenario: Direct native dependent of a held item is dependency-skipped

- **WHEN** merge-mode train holds item 1322
- **AND** GitHub-native discovery fully observes that 1323 is blocked by 1322
- **AND** 1323 has no lexical `Depends on` phrase naming 1322
- **THEN** the train SHALL record 1323 as `dependency-skipped`
- **AND** SHALL NOT advance or merge 1323 while 1322 remains held

#### Scenario: Transitive mixed-source dependent is dependency-skipped

- **WHEN** merge-mode train holds item A
- **AND** native discovery fully observes that B is blocked by A
- **AND** issue C lexically declares `Depends on: #B`
- **THEN** the train SHALL record B and C as `dependency-skipped`
- **AND** SHALL NOT advance or merge B or C while A remains held

#### Scenario: Off-selector native blocker does not skip the depender

- **WHEN** native discovery fully observes that selected issue A is blocked by issue Z
- **AND** Z is not on the frozen selected work-list
- **AND** hard-wait admission ignores Z as `not_on_selector`
- **THEN** A SHALL NOT be recorded `dependency-skipped` solely because of Z
- **AND** A SHALL remain eligible subject to other non-dependency gates
