## MODIFIED Requirements

### Requirement: Train merge mode SHALL integrate each item before starting the next

When `--merge` is provided, the train SHALL integrate work through **base-eligible frontiers** rather than a pure N× one-item serial advance of the entire list without frontier recomputation:

1. Compute the frontier of items whose code prerequisites are integrated (merge-result contained in the fetched base) and eligible to co-advance.
2. **Merge-first prelude:** for every work-list item that is already at `pipeline:ready-to-deploy` (or equivalent) with an open mergeable PR and is not already integrated, reconcile linked PR state, invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`, observe the merge-result, fetch the configured base, and prove the merge-result is contained in the fetched base tip ancestry. This prelude SHALL complete before any plan or implement mutation on any other work-list item. Merges are **serial**.
3. Run one advance wave for the remaining eligible frontier via the loop/advance-wave facade (recovery inside the wave). Pre-ready-to-deploy items MAY enter this wave only after step 2 has merged and contained every already-ready-to-deploy mergeable sibling on the work list.
4. For each frontier item that is at `pipeline:ready-to-deploy` (or equivalent) and not already integrated after that advance wave: reconcile linked PR state across open/closed/merged; if a merge mutation is required, resolve exactly one linked open PR, invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`, observe the merge-result, fetch the configured base, and prove the merge-result is contained in the fetched base tip ancestry — merges are **serial** within the merge wave.
5. Only after prerequisites are merged and contained may a code-dependent successor enter a later advance wave.
6. Pre-ready-to-deploy items SHALL NOT be short-circuited as integrated from a historical merged PR alone.
7. Concurrent capacity for **merge** under merge mode SHALL be one. Advance concurrency inside a frontier follows loop policy (may be >1 when proven independent).
8. The train SHALL NOT treat "no linked open PR" as a hard stop when reconciliation already established a merged linked PR for a ready-to-deploy item.

A log line that says `merge-first` without performing the prelude SHALL NOT satisfy this requirement. Planning or implementing a non-ready-to-deploy sibling while an earlier ready-to-deploy open mergeable PR remains open SHALL fail the train.

#### Scenario: Dependent starts only after prerequisite merge is contained

- **WHEN** issue A is a code prerequisite of issue B in the train
- **AND** A has just reached ready-to-deploy
- **THEN** the train SHALL merge A's pull request and prove base containment before B enters an advance wave
- **AND** B SHALL NOT advance while A's merge-result is not contained in the fetched base

#### Scenario: Squash merge uses merge-result containment not PR-head ancestry

- **WHEN** a squash merge produces merge commit R from reviewed head H
- **THEN** containment proof SHALL require R to be an ancestor of the fetched base tip (or equal to it)
- **AND** the train SHALL NOT require H itself to be an ancestor of the base

#### Scenario: Merge gates refuse unclean PRs

- **WHEN** the linked PR fails an existing `pipeline merge` gate (checks, stage, mergeability, or head)
- **THEN** the train SHALL stop without merging that PR
- **AND** train status SHALL name the gate failure

#### Scenario: Already-merged PR is idempotent success

- **WHEN** reconciliation shows a linked PR (resolved across open, closed, or merged state) is already merged and its merge-result is contained in the fetched base for an item at ready-to-deploy
- **THEN** the train SHALL treat the item as integrated and continue
- **AND** it SHALL NOT attempt a second merge mutation
- **AND** this SHALL hold even when the issue is closed and still labeled `pipeline:ready-to-deploy`

#### Scenario: Reopened pre-ready-to-deploy issue with historical merged PR is not skipped

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready` (or another pre-ready-to-deploy stage) whose only linked PR from prior work is already merged
- **THEN** the train SHALL NOT treat the item as already integrated from that historical PR alone
- **AND** it SHALL advance the item toward ready-to-deploy in an eligible frontier
- **AND** if a new open linked PR exists after advance, the train SHALL merge that PR under the normal merge path

#### Scenario: Already-R2D sibling is merged before any implement of a ready sibling

- **WHEN** the work list contains issue A labeled `pipeline:ready-to-deploy` with an open MERGEABLE PR
- **AND** issue B labeled `pipeline:ready` with no open PR
- **AND** `pipeline train --merge` starts
- **THEN** the first recorded mutation SHALL be the merge of A's pull request
- **AND** the train SHALL prove A's merge-result is contained in the fetched base before any plan or implement harness for B
- **AND** a fixture that plans or implements B first SHALL fail

## ADDED Requirements

### Requirement: Train merge-first SHALL be regression-tested as the first mutation

The test suite SHALL include a hermetic merge-mode fixture whose work list is ready-to-deploy #A with an open MERGEABLE PR plus ready #B. The fixture SHALL fail if any plan, implement, or other non-merge mutation for #B is recorded before the merge surface is invoked for #A. Tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Merge-first fixture bites an advance-then-merge implementation

- **WHEN** the automated merge-first fixture runs against an implementation that advances or implements #B before merging #A
- **THEN** the fixture SHALL fail
- **AND** it SHALL pass when the first mutation is merge of #A
