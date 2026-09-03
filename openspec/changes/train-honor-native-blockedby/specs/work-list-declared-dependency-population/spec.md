## ADDED Requirements

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
