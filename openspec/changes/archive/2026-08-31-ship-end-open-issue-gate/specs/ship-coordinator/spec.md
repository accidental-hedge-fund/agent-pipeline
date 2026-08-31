## ADDED Requirements

### Requirement: Ship coordinator post-train phases SHALL fail closed while any issue on the ship milestone remains open

After merge-mode train is complete or resumed complete, in-engine `pipeline ship --milestone <m>` SHALL re-observe GitHub immediately before every post-train boundary that can start or resume `factory-release prepare`, Factory Reliability Gate (FRG) pack, FRG convergence, release, or `engine-promote`. The observation SHALL list GitHub issues on that ship milestone with `state: open`. It SHALL exclude pull requests. It SHALL exclude closed issues. It SHALL exclude issues with no milestone, including unmilestoned engine-filed factory-gate pack issues. Pipeline labels (`pipeline:backlog`, `pipeline:ready`, `blocked`, or any other) SHALL NOT exempt an open milestoned issue. An engine-filed factory-gate pack issue that is on the ship milestone and still open SHALL count as remaining work. The operator who wants to ship SHALL close, unmilestone, or move those issues. A handoff answer SHALL NOT be required to fire the gate and SHALL NOT waive it.

The query SHALL paginate to exhaustion. It SHALL fail closed on environment-auth, API, parse, or pagination failure, and when the milestone title cannot be resolved. Inability to prove zero remaining open issues SHALL NOT skip the gate. It SHALL NOT be classified as an engine defect that recovery bypasses. The existing `gh` credential path SHALL be used. A new secret or token SHALL NOT be added.

WHEN at least one remaining open issue exists, ship SHALL fail closed before those operations. The fail-closed message SHALL name the milestone and every remaining open issue number, with no cap that drops numbers. Ship SHALL NOT start `factory-release prepare`, FRG pack, FRG convergence, release, or `engine-promote`. A `--skip-frg` flag, label waiver, or persisted gate pass SHALL NOT authorize those operations this cut.

WHEN the observation proves zero remaining open issues, and freeze-eligible items are integrated, ship SHALL still proceed to FRG on the existing all-closed ready-to-deploy / already-integrated path. Train freeze-eligible membership SHALL stay open non-backlog pipeline issues plus closed `pipeline:ready-to-deploy`. This gate SHALL NOT change which issues train advances. Merge authorization SHALL NOT change: `advance`, `single`, and `loop` SHALL still never merge; ship merge-mode train SHALL keep current operator-authorized merge behavior.

Restart and resume SHALL re-observe GitHub at each later post-train boundary. A previously persisted pass, a prior train freeze snapshot, or a completed earlier post-train phase SHALL NOT authorize a later boundary. A path-local skip in one coordinator branch SHALL NOT be sufficient. The next leftover-open-issue on any later ship milestone SHALL hit this same gate.

#### Scenario: Leftover open backlog after completed train blocks FRG

- **WHEN** merge-mode train for `pipeline ship --milestone v1.40.1` has completed
- **AND** GitHub still has open issue #1344 on that milestone labeled `pipeline:backlog`
- **THEN** ship SHALL fail closed before `factory-release prepare` and FRG pack
- **AND** it SHALL NOT start FRG convergence, release, or `engine-promote`
- **AND** the fail-closed message SHALL name milestone `v1.40.1` and `#1344`

#### Scenario: Pipeline labels do not exempt remaining open issues

- **WHEN** the remaining-open observation finds open issues labeled `pipeline:backlog`, `pipeline:ready`, or `blocked` on the ship milestone
- **THEN** those issues SHALL count as remaining work
- **AND** ship SHALL fail closed before FRG pack, release, and `engine-promote`

#### Scenario: Unmilestoned factory-gate pack issues do not count

- **WHEN** an engine-filed factory-gate pack issue is open and has no milestone
- **AND** every issue that does have the ship milestone is closed
- **THEN** the remaining-open check SHALL treat the milestone as having zero remaining open issues
- **AND** ship SHALL be allowed to proceed to FRG after freeze-eligible items are integrated

#### Scenario: Milestoned factory-gate pack issue does count

- **WHEN** an engine-filed factory-gate pack issue is open and assigned the ship milestone
- **THEN** the remaining-open check SHALL count that issue
- **AND** ship SHALL fail closed until the operator unmilestones or closes it

#### Scenario: Pull requests are not remaining milestone work

- **WHEN** the GitHub issues listing for the ship milestone includes an open pull request and no open issues
- **THEN** the remaining-open check SHALL exclude that pull request
- **AND** ship SHALL be allowed to proceed to FRG after freeze-eligible items are integrated

#### Scenario: Query failure fails closed

- **WHEN** GitHub auth, the milestone issue query, parse, or pagination cannot prove that zero open issues remain
- **THEN** ship SHALL fail closed before `factory-release prepare`, FRG pack, release, and `engine-promote`
- **AND** recovery SHALL NOT classify that failure as an engine defect that bypasses the gate

#### Scenario: Restart and resume re-observe GitHub

- **WHEN** a prior remaining-open observation proved zero open issues and FRG pack completed
- **AND** an operator re-invokes `pipeline ship --milestone` for the same milestone
- **AND** GitHub now shows at least one open issue on that milestone
- **THEN** ship SHALL fail closed before the next post-train boundary (FRG convergence, release, or `engine-promote`)
- **AND** it SHALL NOT treat the earlier observation or the completed pack as authorization

#### Scenario: Zero remaining open issues still reaches FRG

- **WHEN** freeze-eligible items are integrated
- **AND** the remaining-open observation proves zero open GitHub issues on the ship milestone
- **THEN** ship SHALL proceed to FRG pack
- **AND** the all-closed ready-to-deploy / already-integrated path SHALL remain available

### Requirement: Remaining-open ship-end regressions SHALL be guarded by automated tests

The test suite SHALL fail if in-engine `pipeline ship --milestone` starts FRG pack or FRG convergence after a completed train when a leftover open `pipeline:backlog` issue remains on that milestone. Separate tests SHALL fail if blocked release or `engine-promote` invokes its operation. Additional tests SHALL prove restart/resume re-observation, pull-request exclusion, pagination to exhaustion, query/parse/pagination failure, unmilestoned factory-gate fixture exclusion, and the no-open-issues path proceeding to FRG. These tests SHALL inject I/O and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Leftover open backlog after train fails CI if FRG runs

- **WHEN** a hermetic fixture models a completed train and a leftover open `pipeline:backlog` issue on the ship milestone
- **AND** the system under test invokes FRG pack or FRG convergence
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Blocked release and promote fail CI if the operation runs

- **WHEN** a hermetic fixture models leftover open milestone issues at a release or `engine-promote` boundary
- **AND** the system under test invokes that operation
- **THEN** the test SHALL fail

#### Scenario: Pagination and query-failure fixtures fail CI if the gate is skipped

- **WHEN** a hermetic fixture models a truncated listing, a parse failure, or a query failure
- **AND** the system under test proceeds as if zero open issues remained
- **THEN** the test SHALL fail
