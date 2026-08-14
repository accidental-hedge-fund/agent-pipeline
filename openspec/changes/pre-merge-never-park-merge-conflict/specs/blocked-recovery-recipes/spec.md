## ADDED Requirements

### Requirement: Pre-merge first-conflict recovery SHALL NOT terminate on the merge-conflict manual-rebase recipe

The pre-merge true-conflict recovery path SHALL NOT call `setBlocked` with
`kind: "merge-conflict"` as the terminal outcome of a first clean auto-rebase conflict
or solely because the clean rebase bound was hit (early-conflict and post-CI
CONFLICTING/DIRTY). The `BlockerKind` value `merge-conflict` and its `BLOCKER_RECIPES`
entry MAY remain for surfaces that still park with that kind (for example merge-queue
hold reporting). Therefore the merge-conflict “Rebase… resolve… push…” recipe SHALL NOT
be the operator-visible terminal for that pre-merge first-conflict case.

#### Scenario: First clean auto-rebase miss does not post merge-conflict recipe

- **WHEN** pre-merge clean auto-rebase hits conflicts with resolution budget remaining
- **THEN** the engine SHALL NOT post a `## Pipeline: Blocked` comment whose kind is
  `merge-conflict` for that step
- **AND** SHALL NOT render the merge-conflict recipe (“Rebase the branch… resolve the
  conflicts…”) as that step’s terminal how-to-unblock section

#### Scenario: Residual merge-conflict kind recipe remains defined if the kind exists

- **WHEN** `BlockerKind` still includes `merge-conflict` for other call sites
- **THEN** `BLOCKER_RECIPES` SHALL continue to provide a non-empty recipe for that kind
- **AND** snapshot/recipe tests for the kind MAY remain
- **AND** those residual definitions SHALL NOT authorize pre-merge first-conflict to
  use that kind as its terminal park
