## ADDED Requirements

### Requirement: A forge merge of this issue's own PR while pre-ready-to-deploy SHALL be treated as a completed remote side effect

When another actor squash-merges or otherwise merges a pull request linked to the issue while the issue is still pre-`pipeline:ready-to-deploy`, train, merge, and advance SHALL observe every linked PR including closed and merged PRs. When any linked PR is merged and its merge-result is contained in the fetched base, side-effect certainty SHALL be `known_complete`. The engine SHALL NOT open a successor PR on the same branch. The engine SHALL NOT rebase commits already contained in that merge onto the merge-result. Local intent that the issue is still in `fix-2` or `pre-merge` SHALL NOT overrule that forge fact.

#### Scenario: Squash-merge during fix-2 does not open a successor PR

- **WHEN** the issue is labeled `pipeline:fix-2`
- **AND** another actor squash-merges the linked PR
- **AND** the merge-result is contained in the fetched base
- **THEN** the operation SHALL reconcile as `known_complete`
- **AND** SHALL NOT open a second PR on the same branch
- **AND** SHALL NOT rebase squash-contained commits onto that merge

#### Scenario: A later open PR does not hide the completed merge

- **WHEN** a later open PR exists on the same branch after that squash-merge
- **THEN** reconciliation SHALL still treat the earlier merged linked PR as `known_complete`
- **AND** SHALL NOT use only the latest open PR as merge authority

#### Scenario: Truncated linked-PR enumeration is not absence

- **WHEN** linked-PR timeline pagination stops before exhaustion
- **AND** no merged-and-contained PR is in the observed window
- **THEN** side-effect certainty SHALL be `uncertain`
- **AND** SHALL NOT be `known_absent`
- **AND** the engine SHALL NOT open a successor PR
- **AND** the engine SHALL NOT rebase squash-contained commits
