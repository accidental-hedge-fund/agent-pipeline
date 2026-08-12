## ADDED Requirements

### Requirement: Train merge mode SHALL treat finished ready-to-deploy items with a merged linked PR as already integrated

When `--merge` is provided and an item carries `pipeline:ready-to-deploy` (or an equivalent ready-to-deploy terminal), the train SHALL reconcile linked pull-request state across open, closed, and merged PR states before requiring an open PR to merge. If reconciliation finds a linked PR that is already merged, the train SHALL treat the item as `already-integrated` (or an equivalent integrated skip), SHALL NOT attempt a merge mutation for that item, and SHALL continue to the next work-list item (or complete successfully when no further items remain). The train SHALL NOT stop with a "ready-to-deploy but has no linked open PR" class blocker for such finished items. When a merge-result commit OID is available, the train SHALL prove that OID is contained in the fetched configured base tip before counting the item as integrated; when the PR is observed merged but containment fails, the train SHALL stop with a containment (or observe) class blocker, not the no-open-PR blocker.

#### Scenario: Closed issue with merged PR and stale ready-to-deploy is skipped as integrated

- **WHEN** `pipeline train --merge` processes an issue that is closed, still labeled `pipeline:ready-to-deploy`, and has a linked pull request that is merged with a merge-result contained in the fetched base
- **THEN** the train SHALL record the item as already integrated
- **AND** it SHALL NOT stop the train for missing open PR
- **AND** it SHALL NOT invoke a merge mutation for that item
- **AND** it SHALL continue to the next item or complete with exit success for that path

#### Scenario: Open issue with since-merged PR and no open PR is skipped as integrated

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready-to-deploy` whose only linked PR is already merged and whose merge-result is contained in the fetched base
- **THEN** the train SHALL treat the item as already integrated
- **AND** it SHALL continue without a second merge mutation

#### Scenario: Open ready-to-deploy issue with no linked PR still fails closed

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready-to-deploy` that has no linked open PR and no linked merged PR
- **THEN** the train SHALL stop with a clear blocker in the "ready-to-deploy but has no linked open PR" class
- **AND** the train exit code SHALL be non-zero
- **AND** no later work-list item SHALL start after that stop

#### Scenario: Open ready-to-deploy issue with open PR still merges

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready-to-deploy` with a linked open pull request
- **THEN** the train SHALL invoke the existing merge surface for that PR
- **AND** it SHALL prove merge-result containment in the fetched base before starting the next item

## MODIFIED Requirements

### Requirement: Train merge mode SHALL integrate each item before starting the next

When `--merge` is provided, for each work-list item in order the train SHALL: (1) when the item is already at `pipeline:ready-to-deploy` (or an equivalent ready-to-deploy terminal), reconcile whether it is already integrated via a linked merged PR resolved across open, closed, or merged PR state and base containment when a merge-result OID is available — pre-ready-to-deploy items SHALL NOT be short-circuited as integrated from a historical merged PR alone; (2) if not already integrated, advance the item to `pipeline:ready-to-deploy` if not already there; (3) resolve exactly one linked open pull request when a merge mutation is still required; (4) invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`; (5) observe the pull request's merge-result commit; (6) fetch the configured base and prove that merge-result is contained in the fetched base tip ancestry; (7) only then start the next item. Concurrent capacity for item advance under merge mode SHALL be one. The train SHALL NOT treat "no linked open PR" as a hard stop when reconciliation already established a merged linked PR for a ready-to-deploy item.

#### Scenario: Dependent starts only after prerequisite merge is contained

- **WHEN** issue A precedes issue B in the train and A has just reached ready-to-deploy
- **THEN** the train SHALL merge A's pull request and prove base containment before advancing B
- **AND** B SHALL NOT start while A's merge-result is not contained in the fetched base

#### Scenario: Squash merge uses merge-result containment not PR-head ancestry

- **WHEN** a squash merge produces merge commit R from reviewed head H
- **THEN** containment proof SHALL require R to be an ancestor of the fetched base tip (or equal to it)
- **AND** the train SHALL NOT require H itself to be an ancestor of the base

#### Scenario: Merge gates refuse unclean PRs

- **WHEN** the linked PR fails an existing `pipeline merge` gate (checks, stage, mergeability, or head)
- **THEN** the train SHALL stop without merging
- **AND** train status SHALL name the gate failure

#### Scenario: Already-merged PR is idempotent success

- **WHEN** reconciliation shows a linked PR (resolved across open, closed, or merged state) is already merged and its merge-result is contained in the fetched base for an item at ready-to-deploy
- **THEN** the train SHALL treat the item as integrated and continue to the next item
- **AND** it SHALL NOT attempt a second merge mutation
- **AND** this SHALL hold even when the issue is closed and still labeled `pipeline:ready-to-deploy`

#### Scenario: Reopened pre-ready-to-deploy issue with historical merged PR is not skipped

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready` (or another pre-ready-to-deploy stage) whose only linked PR from prior work is already merged
- **THEN** the train SHALL NOT treat the item as already integrated from that historical PR alone
- **AND** it SHALL advance the item toward ready-to-deploy
- **AND** if a new open linked PR exists after advance, the train SHALL merge that PR under the normal merge path
