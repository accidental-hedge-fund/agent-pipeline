## MODIFIED Requirements

### Requirement: Queue-complete SHALL mean no remaining R2D candidates and no holds

For release-when-complete, the merge-queue SHALL treat the queue as **complete**
only when both of the following hold after the drive pass (re-queried against
current GitHub/issue state for the same selector used by the drive, e.g.
milestone):

1. There are **no remaining open candidates**: no open issue in the selector that
   still has an open pull request eligible as a merge-queue candidate under
   `pipeline:ready-to-deploy` (and the queue’s other candidate eligibility rules).
2. There are **no held merge-queue items** from the drive. Held items include at
   least: typed `merge-conflict` holds, typed `checks-failed` holds, and
   repair-budget exhaustion / manual-repair outcomes left held after optional
   surgical repair (per `merge-queue-repair-hold`).

Open issues in the selector that are **not** at `pipeline:ready-to-deploy` (or
that lack an eligible open PR) SHALL **not** block release prepare. The command
SHALL emit a warning that reports the presence (count and/or numbers) of such
open non-candidate issues when prepare runs or would run.

If the queue is not complete, the command SHALL skip release prepare even when
release-when-complete is enabled, and SHALL print a clear skip reason naming
whether remaining R2D candidates and/or held items prevented prepare. Skip
reasons that name held items SHOULD include the typed hold reason codes when
available.

#### Scenario: Empty R2D set and no holds is complete

- **WHEN** release-when-complete is enabled and after the drive there are no open
  selector-scoped R2D candidates and no held items
- **THEN** the queue SHALL be considered complete and release prepare SHALL run
  (live) or be reported as would-prepare (dry-run)

#### Scenario: Remaining R2D candidate blocks prepare

- **WHEN** release-when-complete is enabled and at least one open R2D candidate
  remains for the selector after the drive
- **THEN** the command SHALL skip release prepare
- **AND** SHALL print a skip reason that names remaining candidates

#### Scenario: Held item blocks prepare

- **WHEN** release-when-complete is enabled and at least one item is held after
  the drive
- **THEN** the command SHALL skip release prepare
- **AND** SHALL print a skip reason that names held items

#### Scenario: Typed conflict hold blocks prepare

- **WHEN** release-when-complete is enabled and the drive result includes a
  `merge-conflict` hold (including after repair budget exhaustion left the item
  held)
- **THEN** the command SHALL skip release prepare
- **AND** SHALL treat that item as a held merge-queue item for completeness

#### Scenario: Checks-failed hold blocks prepare

- **WHEN** release-when-complete is enabled and the drive result includes a
  `checks-failed` hold
- **THEN** the command SHALL skip release prepare
- **AND** SHALL treat that item as a held merge-queue item for completeness

#### Scenario: Open non-R2D issues do not block prepare

- **WHEN** release-when-complete is enabled, the queue is complete by the R2D and
  hold criteria, and the milestone still has open issues that are not
  ready-to-deploy candidates
- **THEN** the command SHALL still run release prepare (live) or report
  would-prepare (dry-run)
- **AND** SHALL emit a warning disclosing those open non-candidate issues
