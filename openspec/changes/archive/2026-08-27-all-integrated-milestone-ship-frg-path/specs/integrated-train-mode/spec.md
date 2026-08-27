## MODIFIED Requirements

### Requirement: The CLI SHALL provide an opt-in integrated train command

The Pipeline CLI SHALL expose a loop-isolated `train` command that accepts a work selector of at least one of: an explicit ordered issue list, or a milestone name that resolves to freeze-eligible pipeline issues. Freeze-eligible issues SHALL include open non-backlog pipeline issues and closed issues labeled `pipeline:ready-to-deploy`. The command SHALL NOT be reachable from `pipeline advance` stage dispatch. The command SHALL refuse to run when no work selector is provided. The command SHALL NOT refuse a milestone solely because every freeze-eligible issue is closed.

#### Scenario: Explicit issue list is accepted

- **WHEN** an operator runs `pipeline train --issues 10,11,12`
- **THEN** the train SHALL resolve those issue numbers as the work list in the given order after dependency validation
- **AND** it SHALL NOT invoke advance-stage merge logic

#### Scenario: Milestone selector is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.34.0`
- **THEN** the train SHALL resolve the milestone's freeze-eligible issues into a dependency-ordered work list using existing declared-dependency discovery
- **AND** it SHALL refuse a cycle with a validation error

#### Scenario: All-closed ready-to-deploy milestone is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.39.13 --merge`
- **AND** every freeze-eligible issue in that milestone is closed, labeled `pipeline:ready-to-deploy`, and has a linked PR merged and contained in the fetched base
- **THEN** the train SHALL accept the milestone selector
- **AND** it SHALL NOT exit with `has no open issues` or an equivalent open-only empty-list error
- **AND** it SHALL record each item as already integrated

#### Scenario: Missing selector is refused

- **WHEN** an operator runs `pipeline train` with neither issues nor milestone
- **THEN** the command SHALL exit non-zero with an error naming the required selector

## ADDED Requirements

### Requirement: Ship train freeze SHALL admit already-integrated milestone items

In-engine `pipeline ship --milestone <m>` train freeze SHALL build the ship plan from freeze-eligible issues in that milestone: open non-backlog pipeline issues, plus closed issues labeled `pipeline:ready-to-deploy`. When every freeze-eligible issue is closed at `pipeline:ready-to-deploy` with its linked pull request merged and the merge-result contained in the fetched base, freeze SHALL include those issues in the ordered plan and SHALL proceed to train merge-mode (which records `already-integrated`) and then to the FRG / release phase. Freeze SHALL NOT stop with `no open issues to freeze` or an equivalent open-only empty-list error solely because the open-issue subset is empty. Freeze SHALL still fail closed when the milestone has no freeze-eligible issues. Freeze SHALL NOT invent a second already-integrated classifier; train merge-mode SHALL remain the authority for `already-integrated` vs containment / no-linked-PR blockers.

#### Scenario: All-integrated milestone proceeds past freeze

- **WHEN** `pipeline ship --milestone v1.39.13` freezes a milestone whose freeze-eligible issues are all closed, labeled `pipeline:ready-to-deploy`, and have linked PRs merged and contained in the fetched base
- **THEN** freeze SHALL return an ordered plan that includes those issues
- **AND** it SHALL NOT throw `no open issues to freeze`
- **AND** train merge-mode SHALL record each item `already-integrated`
- **AND** the ship run SHALL proceed to the FRG / release phase for that shipment

#### Scenario: Empty freeze-eligible set still fails

- **WHEN** `pipeline ship --milestone <m>` freezes a milestone that has no open non-backlog pipeline issues and no closed `pipeline:ready-to-deploy` issues
- **THEN** freeze SHALL fail closed
- **AND** the error SHALL name that the milestone has no freeze-eligible issues
- **AND** the ship run SHALL NOT proceed to release as if the milestone were integrated

#### Scenario: Closed ready-to-deploy without merged contained PR is not skipped at freeze

- **WHEN** freeze admits a closed issue labeled `pipeline:ready-to-deploy` whose linked PR is missing or whose merge-result is not contained in the fetched base
- **THEN** train merge-mode SHALL apply existing already-integrated / no-open-PR / containment fail-closed law
- **AND** freeze SHALL NOT classify that item as integrated on its own

### Requirement: Mixed open and already-integrated milestone items SHALL complete in one run

When a ship or merge-mode train work list contains both (a) open `pipeline:ready-to-deploy` items with a linked open mergeable PR and (b) already-integrated items (closed or open ready-to-deploy with a merged contained PR), the same run SHALL merge the open mergeable items under existing merge-wave law and SHALL record the already-integrated items as `already-integrated` without a second merge mutation. The run SHALL NOT drop the already-integrated set from the plan solely because freeze listed only open issues.

#### Scenario: Mixed milestone merges open items and skips integrated items

- **WHEN** `pipeline ship --milestone <m>` (or `pipeline train --milestone <m> --merge`) runs on a milestone with open ready-to-deploy issue A (open mergeable PR) and closed ready-to-deploy issue B (merged PR contained in the fetched base)
- **THEN** the freeze / milestone listing SHALL include both A and B
- **AND** the run SHALL invoke the existing merge surface for A's PR
- **AND** the run SHALL record B as `already-integrated` without a merge mutation for B
- **AND** a successful path SHALL complete that work list in one run

### Requirement: All-integrated freeze regressions SHALL be guarded by automated tests

The test suite SHALL fail if ship freeze or `pipeline train --milestone` rejects a milestone whose freeze-eligible issues are all closed at `pipeline:ready-to-deploy` with merged contained PRs, instead of classifying those items as already integrated. The suite SHALL also fail if a mixed open + already-integrated fixture omits the already-integrated items from the plan or skips merging the open mergeable item. These tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: All-closed merged freeze rejection fails CI

- **WHEN** a hermetic fixture models a milestone of closed `pipeline:ready-to-deploy` issues with merged contained PRs
- **AND** freeze or train milestone listing throws `no open issues to freeze` or `has no open issues` (or equivalent open-only empty-list error)
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Mixed-plan omission fails CI

- **WHEN** a hermetic fixture models one open mergeable ready-to-deploy item and one already-integrated item
- **AND** the system under test omits the already-integrated item from the plan or does not offer the open item to the merge surface
- **THEN** the test SHALL fail
