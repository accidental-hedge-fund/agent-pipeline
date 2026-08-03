## ADDED Requirements

### Requirement: Restack or conflict repair SHALL fail closed on a large unrelated documentation landing-page breach

When merge-queue restack, deterministic rebase, or optional surgical/mechanical repair produces a candidate head whose root `README.md` violates the `docs-landing-split` landing-page contract (including a #793-class large monolithic append unrelated to the held conflict or CI failure), the queue SHALL treat that head as **not** re-gate eligible for merge. The path SHALL fail closed or retain a typed hold with operator-visible diagnostics that name the documentation contract breach. The queue SHALL NOT force-merge, SHALL NOT treat the item as successfully repaired solely because conflict markers cleared, and SHALL NOT silently advance that head toward merge while the landing-page contract is red. This requirement does not change merge-authority rules, `auto_merge` posture, or review-policy thresholds; it is a deterministic control check on documentation contract compliance after head movement.

#### Scenario: Monolithic README after repair blocks re-gate merge eligibility

- **WHEN** repair or restack moves the PR head
- **AND** the new head's `README.md` has 400 or more lines or otherwise fails the landing-page contract enforced by the docs check surface
- **THEN** re-gate SHALL NOT report the item as eligible to merge
- **AND** the queue SHALL NOT call `mergePr` for that head as a successful repair outcome
- **AND** diagnostics or hold evidence SHALL mention the README / landing-page / docs-contract breach class

#### Scenario: Conflict resolved but landing page broken is not a clean repair

- **WHEN** implementer or deterministic repair clears merge conflicts
- **AND** the same head reintroduces a large unrelated monolithic README append
- **THEN** the item SHALL remain held or otherwise non-eligible
- **AND** SHALL NOT be classified as a successful surgical repair solely on conflict clearance

#### Scenario: Compliant lean README does not create a false hold

- **WHEN** repair or restack leaves `README.md` within the landing-page contract
- **AND** other eligibility gates pass
- **THEN** this documentation-contract rule SHALL NOT by itself hold the item
