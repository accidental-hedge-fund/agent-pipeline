## MODIFIED Requirements

### Requirement: Ship train freeze SHALL admit already-integrated milestone items

In-engine `pipeline ship --milestone <m>` train freeze SHALL build the ship plan from freeze-eligible issues in that milestone: open non-backlog pipeline issues, plus closed issues labeled `pipeline:ready-to-deploy`. Freeze-eligible membership SHALL be train membership only. It SHALL NOT be proof that the milestone has no remaining open GitHub issues. It SHALL NOT authorize Factory Reliability Gate (FRG) pack, release, or promotion.

When every freeze-eligible issue is closed at `pipeline:ready-to-deploy` with its linked pull request merged and the merge-result contained in the fetched base, freeze SHALL include those issues in the ordered plan and SHALL proceed to train merge-mode (which records `already-integrated`). Freeze SHALL NOT stop with `no open issues to freeze` or an equivalent open-only empty-list error solely because the open-issue subset is empty. Freeze SHALL still fail closed when the milestone has no freeze-eligible issues. Freeze SHALL NOT invent a second already-integrated classifier; train merge-mode SHALL remain the authority for `already-integrated` vs containment / no-linked-PR blockers.

After train merge-mode completes, ship SHALL proceed to the FRG / release phase only when the ship-end remaining-open check proves zero open GitHub issues on that milestone. A leftover open issue on that milestone, including an issue labeled `pipeline:backlog`, SHALL fail closed before FRG, release, and promote. This requirement SHALL NOT change which issues train advances.

#### Scenario: All-integrated milestone proceeds past freeze

- **WHEN** `pipeline ship --milestone v1.39.13` freezes a milestone whose freeze-eligible issues are all closed, labeled `pipeline:ready-to-deploy`, and have linked PRs merged and contained in the fetched base
- **THEN** freeze SHALL return an ordered plan that includes those issues
- **AND** it SHALL NOT throw `no open issues to freeze`
- **AND** train merge-mode SHALL record each item `already-integrated`
- **AND** freeze-eligible integration alone SHALL NOT start FRG, release, or promote

#### Scenario: Empty freeze-eligible set still fails

- **WHEN** `pipeline ship --milestone <m>` freezes a milestone that has no open non-backlog pipeline issues and no closed `pipeline:ready-to-deploy` issues
- **THEN** freeze SHALL fail closed
- **AND** the error SHALL name that the milestone has no freeze-eligible issues
- **AND** the ship run SHALL NOT proceed to release as if the milestone were integrated

#### Scenario: Closed ready-to-deploy without merged contained PR is not skipped at freeze

- **WHEN** freeze admits a closed issue labeled `pipeline:ready-to-deploy` whose linked PR is missing or whose merge-result is not contained in the fetched base
- **THEN** train merge-mode SHALL apply existing already-integrated / no-open-PR / containment fail-closed law
- **AND** freeze SHALL NOT classify that item as integrated on its own

#### Scenario: Leftover open backlog does not ride freeze-eligible integration into FRG

- **WHEN** freeze-eligible items on milestone `v1.40.1` are integrated
- **AND** GitHub still has open issue #1344 on that milestone labeled `pipeline:backlog`
- **THEN** train freeze-eligible membership SHALL NOT include #1344
- **AND** ship SHALL fail closed before FRG pack, release, and `engine-promote`
- **AND** the fail-closed path SHALL be the remaining-open check, not a change to which issues train advances
