## ADDED Requirements

### Requirement: Never-pushed unpublished commits SHALL classify as local-only, not squash-merge unreachability

When local-only verification observes that the remote managed head ref is absent (successful empty `ls-remote`) and commits on the managed worktree or branch are not reachable from `origin/<base>`, the shared ladder SHALL classify the result as **local-only** (hard retain) when there is no bound merge-result proof and no linked merged PR for that issue. It SHALL NOT classify that observation as squash-merge unreachability (`unverifiable`) and SHALL NOT tell the operator to `--force` because the work was squash-merged. Squash-merge unreachability SHALL remain the classification only when bound merge-result proof or a linked merged PR shows the head was published and then deleted after merge. Park-release SHALL retain the worktree in the local-only case so unpublished salvage remains recoverable.

#### Scenario: Never-pushed salvage retains as local-only

- **WHEN** park-release or remove-safety runs for issue N
- **AND** `ls-remote` for the managed branch succeeds with an empty SHA (remote head never existed or is absent)
- **AND** local HEAD commits are not reachable from `origin/<base>`
- **AND** no bound merge-result proof and no linked merged PR exist for issue N
- **THEN** the shared ladder SHALL classify the result as local-only
- **AND** park-release SHALL retain the worktree
- **AND** operator-visible text SHALL NOT contain `cannot verify all commits are merged` or `use --force to proceed if work was squash-merged`

#### Scenario: Proven squash-merge remains unverifiable

- **WHEN** the remote managed head is absent
- **AND** commits are not reachable from `origin/<base>`
- **AND** bound merge-result proof or a linked merged PR exists for that issue
- **THEN** the shared ladder SHALL still classify the result as squash-merge unreachability
- **AND** SHALL NOT reclassify a proven squash-merge as local-only unpublished work

#### Scenario: Force is not the unpublished-salvage recovery path

- **WHEN** unpublished local commits exist on the managed issue branch with no remote head and no merged PR
- **THEN** automatic park-release SHALL NOT pass operator `--force`
- **AND** SHALL NOT delete the worktree that holds the unpublished salvage or checkpoint commit
