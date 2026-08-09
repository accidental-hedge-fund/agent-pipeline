# integrated-train-mode Specification

## Purpose
TBD - created by archiving change add-integrated-train-mode. Update Purpose after archive.
## Requirements
### Requirement: The CLI SHALL provide an opt-in integrated train command

The Pipeline CLI SHALL expose a loop-isolated `train` command that accepts a work selector of at least one of: an explicit ordered issue list, or a milestone name that resolves to open pipeline issues. The command SHALL NOT be reachable from `pipeline advance` stage dispatch. The command SHALL refuse to run when no work selector is provided.

#### Scenario: Explicit issue list is accepted

- **WHEN** an operator runs `pipeline train --issues 10,11,12`
- **THEN** the train SHALL resolve those issue numbers as the work list in the given order after dependency validation
- **AND** it SHALL NOT invoke advance-stage merge logic

#### Scenario: Milestone selector is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.34.0`
- **THEN** the train SHALL resolve the milestone's issues into a dependency-ordered work list using existing declared-dependency discovery
- **AND** it SHALL refuse a cycle with a validation error

#### Scenario: Missing selector is refused

- **WHEN** an operator runs `pipeline train` with neither issues nor milestone
- **THEN** the command SHALL exit non-zero with an error naming the required selector

---

### Requirement: Default train advance SHALL stop each item at ready-to-deploy without merging

When `--merge` is not provided, the train SHALL advance each work-list item through the existing Pipeline advance surface until the item reaches a terminal stage of `pipeline:ready-to-deploy` or `pipeline:needs-human` (or an equivalent typed park/block that stops the item). The train SHALL NOT call `mergePr` or the merge-queue apply path.

#### Scenario: Non-merge train leaves PRs unmerged

- **WHEN** a train without `--merge` finishes an item at `pipeline:ready-to-deploy`
- **THEN** the linked pull request SHALL remain open
- **AND** no merge API call SHALL be recorded for that item

#### Scenario: needs-human parks the train

- **WHEN** an item reaches `pipeline:needs-human` during a non-merge or merge train
- **THEN** the train SHALL stop scheduling further forward items
- **AND** train status SHALL name the issue and park reason

---

### Requirement: Train merge mode SHALL integrate each item before starting the next

When `--merge` is provided, for each work-list item in order the train SHALL: (1) advance the item to `pipeline:ready-to-deploy` if not already there; (2) resolve exactly one linked open pull request; (3) invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`; (4) observe the pull request's merge-result commit; (5) fetch the configured base and prove that merge-result is contained in the fetched base tip ancestry; (6) only then start the next item. Concurrent capacity for item advance under merge mode SHALL be one.

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

- **WHEN** reconciliation shows the linked PR is already merged and its merge-result is contained in the fetched base
- **THEN** the train SHALL treat the item as integrated and continue to the next item
- **AND** it SHALL NOT attempt a second merge mutation

---

### Requirement: Train status and events SHALL be machine-readable for supervisors

The train SHALL expose a status read model (CLI status and/or JSON events) that includes train identity, ordered issue list, current issue, current stage or item state, linked PR when known, last merge-result identity when known, next action, and blocker if stopped. Notification failure by an external supervisor SHALL NOT change train or Pipeline state.

#### Scenario: Status names the current item and next action

- **WHEN** an operator or supervisor requests train status during an active train
- **THEN** the status SHALL include the current issue number and the next deterministic action (advance, merge, wait-for-base, complete, or stopped)

#### Scenario: Events do not authorize mutations

- **WHEN** train events are streamed to a notifier
- **THEN** those events SHALL be observational only
- **AND** they SHALL NOT grant merge or advance authority

---

### Requirement: Train SHALL reconcile from GitHub and Pipeline truth on restart

On restart or resume of a named train, the implementation SHALL re-read live issue labels, pull-request merge state, and fetched base identity before performing a new mutation. The train SHALL NOT trust chat memory or a supervisor prompt as authoritative stage or merge state.

#### Scenario: Resume after process death does not double-merge

- **WHEN** a train process dies after a successful merge mutation but before the next item starts
- **THEN** a resumed train SHALL observe the merged PR and contained merge-result
- **AND** it SHALL NOT invoke merge again for that item

#### Scenario: Ambiguous ownership fails closed

- **WHEN** live ownership artifacts for the current issue are split or unreadable (for example conflicting active run records that block advance)
- **THEN** the train SHALL stop with a typed ownership or reconcile error
- **AND** it SHALL NOT delete unpushed commits to force progress

