## ADDED Requirements

### Requirement: Post-managed-PR create-or-reuse SHALL supersede other open issue-linked PRs

After the pipeline has determined the live managed pull request for issue N on the current managed head branch (whether that PR was newly created or reused via exact-head match), the pipeline SHALL run a supersession sweep for issue N. The sweep SHALL identify every open same-repository pull request that is issue-linked to N under the dual PR-resolution strategies (head branch starts with `pipeline/<N>-` and is not from a fork, or target-repo `closingIssuesReferences` contains issue N) whose head branch is **not** the current managed head branch, and SHALL apply the configured supersede action to each such PR. The sweep SHALL run on both first open and resume/reuse paths. Exact-head reuse for the managed branch SHALL remain unchanged: the managed head’s own PR SHALL NOT be closed or treated as superseded by this sweep.

#### Scenario: create managed PR closes other open issue-linked PR

- **WHEN** issue N has an open same-repo PR A whose head is not the managed branch and that is issue-linked via dual strategy
- **AND** the post-implement path creates managed PR B for the managed head branch
- **AND** `supersede_mode` is `close` or omitted (default)
- **THEN** the pipeline SHALL close PR A
- **AND** SHALL leave PR B open
- **AND** SHALL NOT close PR B as superseded

#### Scenario: exact-head reuse still supersedes sibling open PRs

- **WHEN** managed PR B already exists for the managed head branch and is reused without calling create
- **AND** open same-repo issue-linked PR A exists on a different head
- **AND** `supersede_mode` is `close` or omitted
- **THEN** the pipeline SHALL still run the supersession sweep
- **AND** SHALL close PR A
- **AND** SHALL keep PR B open

#### Scenario: managed head PR is never self-superseded

- **WHEN** the only open issue-linked PR for N is the managed PR on the managed head
- **THEN** the supersession sweep SHALL NOT close that PR
- **AND** SHALL NOT post a superseded comment on that PR as if it were stale

### Requirement: Supersede candidates SHALL use dual strategy, same base, and exclude non-linked PRs

A pull request SHALL be a supersede candidate for issue N only when all of the following hold: it is open; it is same-repository (not a fork / cross-repository PR); it is issue-linked under dual strategy for N (same-repo head prefix `pipeline/<N>-` or target-repo closing reference to N); its head branch name is not equal to the managed head branch; its base branch equals the pipeline integration base (`cfg.base_branch`); and its number is not the live managed PR number. The pipeline SHALL NOT treat body-text or title mentions of the issue number alone (without dual-strategy match) as issue linkage for supersession. The pipeline SHALL NOT supersede PRs that target a different base than `cfg.base_branch`.

#### Scenario: body-only mention is not a candidate

- **WHEN** an open PR’s body or title mentions `#N` or `Fixes #N` but its `closingIssuesReferences` do not include issue N in the target repo
- **AND** its head does not start with `pipeline/<N>-` (or it is a fork spoofing that prefix)
- **THEN** the supersession sweep SHALL NOT close that PR
- **AND** SHALL NOT post a `pipeline-superseded` comment on that PR

#### Scenario: different-base issue-linked PR is left alone

- **WHEN** an open same-repo PR is issue-linked to N under dual strategy
- **AND** its base branch is not `cfg.base_branch`
- **THEN** the supersession sweep SHALL NOT close that PR
- **AND** SHALL NOT post a `pipeline-superseded` comment on that PR

#### Scenario: fork cannot spoof pipeline branch prefix for supersession

- **WHEN** an open fork PR has head branch `pipeline/N-spoofed`
- **AND** its closing references do not include issue N in the target repo
- **THEN** the supersession sweep SHALL NOT treat it as a candidate

### Requirement: Default supersede action is close with a structured pipeline-superseded comment

When `supersede_mode` is `close` or the key is omitted, for each supersede candidate the pipeline SHALL post a structured comment on that PR that names the superseding managed PR number, issue N, and the reason token `pipeline-superseded`, and SHALL close that PR. Partial failure on one candidate (comment or close error) SHALL NOT prevent attempting remaining candidates and SHALL NOT block advancement of issue N past the post-implement PR step solely because supersession failed.

#### Scenario: closed PR carries superseding PR identity

- **WHEN** the default close mode supersedes PR A in favor of managed PR B for issue N
- **THEN** PR A SHALL receive a comment containing PR B’s number and the token `pipeline-superseded`
- **AND** PR A SHALL be closed

#### Scenario: supersede close failure does not block advance

- **WHEN** closing or commenting on a supersede candidate fails
- **AND** the managed PR was successfully created or reused
- **THEN** the pipeline SHALL still complete the post-implement PR path for the managed PR (including stage transition toward design-gate/review as already specified)
- **AND** SHALL record a diagnostic log for the failed candidate

### Requirement: comment-only mode posts and leaves candidates open

When `supersede_mode` is `comment-only`, for each supersede candidate the pipeline SHALL post a structured comment naming the superseding managed PR number, issue N, and the reason token `pipeline-superseded`, and SHALL NOT close that PR as part of the supersession sweep.

#### Scenario: comment-only leaves sibling open

- **WHEN** open issue-linked PR A is a supersede candidate for managed PR B
- **AND** `supersede_mode` is `comment-only`
- **THEN** the pipeline SHALL post a `pipeline-superseded` comment on PR A naming PR B
- **AND** SHALL leave PR A open

### Requirement: Supersession sweep is covered by injectable-dep regression tests

The repository test suite SHALL include regression coverage that constructs a fixture with two open issue-linked PRs for the same issue on different heads and asserts that after the post-implement create-or-reuse path (or the supersede helper invoked as that path does), only the managed PR remains open under default mode (or that comment-only posts without close). Tests SHALL inject dependency seams (no real network, git, or subprocess as the sole pass path) and SHALL fail if the supersede close/comment step is removed or skipped after managed PR create-or-reuse. Tests SHALL also cover concurrent managed-head election: only the elected winner closes the peer, and a losing post-implement path does not transition onward.

#### Scenario: multi-PR fixture closes only the non-managed head

- **WHEN** unit tests inject open PR A (other head, dual-strategy linked) and managed PR B (managed head)
- **AND** the supersede path runs in default close mode
- **THEN** the test SHALL assert close was invoked for A and not for B
- **AND** the test setup SHALL fail if the production path no longer invokes supersession after create-or-reuse

#### Scenario: comment-only mode asserted in tests

- **WHEN** unit tests run the supersede path with `supersede_mode` `comment-only`
- **THEN** the test SHALL assert a superseded comment on A and no close of A

#### Scenario: concurrent managed heads — only elected winner survives close

- **WHEN** unit tests inject two open same-base managed heads `pipeline/<N>-*` for issue N with PR numbers A < B
- **AND** both hosts run the supersede path against the same open set
- **THEN** the host whose managed PR is A SHALL NOT close or comment on B
- **AND** the host whose managed PR is B SHALL close A and SHALL NOT close B

### Requirement: Concurrent managed heads SHALL elect one GitHub-authoritative winner before superseding

Before applying any supersede comment or close for issue N, the supersession sweep SHALL elect a single managed winner among open same-repository, same-base pull requests whose head branch starts with `pipeline/<N>-` (non-fork). The election rule SHALL be highest PR number wins. The caller's managed PR identity SHALL always participate in the election even if it is missing from a partial open-PR list. The sweep SHALL revalidate this election from a fresh open-PR list immediately before acting. When the caller's managed PR is not the elected winner, the sweep SHALL NOT comment on or close any candidate (including the elected winner), SHALL report a lost-election outcome, and the post-implement path SHALL stop without transitioning away from `implementing` and without setting `pipeline:blocked` on the issue (so the winning host is not stalled). When the caller's managed PR is the elected winner, supersession of other candidates SHALL proceed under the configured `supersede_mode` as elsewhere in this capability.

#### Scenario: lower-numbered concurrent managed PR does not close the higher-numbered peer

- **WHEN** open managed PR A on `pipeline/N-host-a` and open managed PR B on `pipeline/N-host-b` both exist for issue N with A < B
- **AND** the host whose managed PR is A runs the supersession sweep
- **THEN** the sweep SHALL elect B as winner
- **AND** SHALL NOT close or comment-flag PR B
- **AND** SHALL NOT close or comment-flag any other candidate under that lost-election outcome

#### Scenario: higher-numbered concurrent managed PR supersedes the lower-numbered peer

- **WHEN** open managed PR A and open managed PR B exist for issue N with A < B
- **AND** the host whose managed PR is B runs the supersession sweep in default close mode
- **THEN** the sweep SHALL elect B as winner
- **AND** SHALL close PR A with a `pipeline-superseded` comment naming B
- **AND** SHALL leave PR B open

#### Scenario: losing host stops without blocking the issue

- **WHEN** the post-implement path's supersession sweep reports a lost managed-head election for issue N
- **THEN** the path SHALL NOT transition `implementing → design-gate`
- **AND** SHALL NOT set `pipeline:blocked` on issue N
- **AND** SHALL return a non-advancing waiting outcome that names the elected winning PR
