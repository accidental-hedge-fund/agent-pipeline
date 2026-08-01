## ADDED Requirements

### Requirement: Supersede open associated PRs after managed PR ensure

The engine SHALL, after creating or reusing the open same-repo PR for issue N on the current managed head branch H, identify every other open PR associated with N under the living dual strategies of `pr-resolution` (same-repo head branch starting with `pipeline/<N>-`, or target-repo `closingIssuesReferences` containing N) whose head branch is not H and whose number is not the managed PR number. For each such PR that targets base `cfg.base_branch`, the engine SHALL dispose it under the active supersede mode **only when the managed PR for H is the GitHub-elected canonical managed pipeline PR for N** (see Requirement: Canonical managed PR election before supersede dispose). The engine SHALL NOT use title or body text search to associate PRs with N for this path. The engine SHALL NOT dispose the managed PR for H, PRs not associated with N under dual strategies, fork branch-prefix spoofs excluded by `pr-resolution`, or associated open PRs whose base is not `cfg.base_branch`.

#### Scenario: Second open PR on different head is closed by default

- **WHEN** issue N has managed head branch H with open PR M
- **AND** M is the GitHub-elected canonical open managed pipeline PR for N
- **AND** another open same-repo PR S is associated with N under dual strategies
- **AND** S's head is not H and S's base is `cfg.base_branch`
- **AND** supersede mode is `close` (default)
- **THEN** the engine SHALL close PR S
- **AND** SHALL leave a structured comment on S that includes the marker
  `pipeline-superseded` and names superseding PR M
- **AND** SHALL leave PR M open

#### Scenario: Exact-head managed PR is never superseded

- **WHEN** the only open associated PR for N is the managed PR M on head H
- **THEN** the engine SHALL NOT close or supersede-comment PR M

#### Scenario: Unrelated open PR is not closed

- **WHEN** an open PR U is not associated with N under dual strategies
- **AND** supersede disposal runs for issue N after ensure-PR on managed head H
- **THEN** the engine SHALL NOT close or supersede-comment PR U

#### Scenario: Body-only mention is not treated as associated

- **WHEN** an open PR's body or title mentions `#N` or `Fixes #N` but it has neither a
  same-repo `pipeline/<N>-*` head nor a target-repo closing reference for N
- **THEN** supersede disposal for issue N SHALL NOT select that PR

#### Scenario: Different-base associated PR is left open

- **WHEN** an open PR S is associated with N under dual strategies
- **AND** S's head is not the managed head H
- **AND** S's base is not `cfg.base_branch`
- **THEN** the engine SHALL NOT close PR S as superseded

### Requirement: Canonical managed PR election before supersede dispose

Before closing or supersede-commenting any open associated PR for issue N, the engine SHALL elect a single canonical open managed pipeline PR from GitHub-visible open PR state: contenders SHALL be same-repo open PRs whose head starts with `pipeline/<N>-` and whose base is `cfg.base_branch`, plus the caller's ensured managed PR number (so list lag cannot elect a foreign winner when this run is the only managed head). The elected winner SHALL be the highest PR number among contenders. Closing-ref-only associated heads SHALL NOT be election contenders. The engine SHALL re-list open candidates and re-elect immediately before any close/comment action. Only when the caller's managed PR number equals the elected canonical SHALL the engine dispose other associated same-base PRs. When the caller's managed PR is not canonical, the engine SHALL NOT close or supersede-comment any candidate (including the elected winner) and SHALL report non-canonical status to the caller.

#### Scenario: Concurrent managed heads — only highest PR disposes

- **WHEN** two open same-base managed pipeline PRs exist for issue N on different
  `pipeline/<N>-*` heads with numbers P_low and P_high (P_high > P_low)
- **AND** host A ensures P_low and host B ensures P_high
- **AND** both run supersede disposal against a snapshot that includes both
- **THEN** host A SHALL observe non-canonical status and SHALL NOT close P_high
- **AND** host B SHALL be canonical and MAY close P_low under supersede rules
- **AND** the hosts SHALL NOT mutually close each other's managed PRs

#### Scenario: Non-canonical run does not close the winner

- **WHEN** this run's managed PR M is open
- **AND** another open same-base `pipeline/<N>-*` PR W has a higher number than M
- **THEN** supersede disposal for M SHALL return non-canonical
- **AND** SHALL NOT close or supersede-comment W

#### Scenario: Revalidation loses election and cancels dispose

- **WHEN** an initial open-list elects this run's managed PR M as canonical
- **AND** the immediate revalidation list shows a higher open same-base
  `pipeline/<N>-*` PR W
- **THEN** the engine SHALL treat the run as non-canonical
- **AND** SHALL NOT close or supersede-comment any candidate

### Requirement: Supersede mode close versus comment-only

The supersede path SHALL support configuration `supersede_mode` with values `close` and `comment-only`. When the key is absent, the engine SHALL behave as `close`. Under `close`, each selected superseded PR SHALL be closed with the structured `pipeline-superseded` comment naming the superseding PR. Under `comment-only`, the engine SHALL post the same class of structured comment and SHALL leave the superseded PR open. Neither mode SHALL merge a PR, force-push a branch, or delete a branch/worktree as part of supersede disposal.

#### Scenario: Default mode closes

- **WHEN** `supersede_mode` is unset
- **AND** a superseded candidate PR S exists for issue N
- **THEN** the engine SHALL close S with a `pipeline-superseded` comment

#### Scenario: Comment-only leaves PR open

- **WHEN** `supersede_mode` is `comment-only`
- **AND** a superseded candidate PR S exists for issue N with superseding PR M
- **THEN** the engine SHALL post a structured comment on S including
  `pipeline-superseded` and naming M
- **AND** SHALL NOT close S

### Requirement: Supersede disposal is fail-soft for advance

Supersede disposal SHALL treat failure to list open associated PRs, or failure to close/comment an individual superseded PR, as non-blocking for managed PR ensure: such failures SHALL be logged and SHALL NOT by itself block the managed PR ensure path or the subsequent stage transition when the managed PR for head H is otherwise successfully created or reused. Individual superseded PRs SHALL be attempted independently so one failure does not skip remaining candidates.

#### Scenario: One close failure does not block advance

- **WHEN** two superseded candidates S1 and S2 exist
- **AND** close of S1 fails and close of S2 succeeds
- **THEN** the engine SHALL still complete managed PR ensure successfully
- **AND** SHALL leave a log/diagnostic for the S1 failure
- **AND** SHALL have closed S2

#### Scenario: Open-list failure does not drop managed PR

- **WHEN** listing open associated PRs for issue N fails after managed PR M is known
- **THEN** the engine SHALL NOT treat managed PR ensure as failed solely for that list failure
- **AND** SHALL leave M open for subsequent stages

### Requirement: Supersede selection and disposition are unit-testable without network

Selection of superseded PR numbers from a candidate set and the mode-dependent disposition decision SHALL be injectable or pure so unit tests can supply fixtures with multiple open PRs for one issue on different heads and assert outcomes without real network, git, or subprocess calls. Tests SHALL cover default close (only managed PR remains open among associated same-base PRs), comment-only (comment posted, PR left open), exclusion of unrelated and different-base PRs, and SHALL prove the close/comment step is what changes the open set (bite without disposal).

#### Scenario: Fixture two open PRs — only managed remains under close

- **WHEN** a unit fixture has open associated PRs M (head H) and S (head other)
  with same base
- **AND** disposal runs in `close` mode for managed PR M / head H
- **THEN** the test-observed open associated set SHALL contain M and not S

#### Scenario: Test bites without disposal

- **WHEN** the same fixture runs without invoking close/comment disposal
- **THEN** both M and S remain open in the fixture observation
- **AND** that observation is asserted so a missing disposal step fails the suite
