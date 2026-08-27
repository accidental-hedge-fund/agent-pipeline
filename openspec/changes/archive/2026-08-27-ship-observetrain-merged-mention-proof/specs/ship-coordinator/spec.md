## ADDED Requirements

### Requirement: Ship train observation SHALL prove integration from merged pipeline mentions

Ship train observation SHALL treat the planned issues as integrated when each issue has a same-repo pull request that any-state resolution links (ConnectedEvent, closing `willCloseTarget`, head `pipeline/<N>-*`, or title parenthetical `(#N)`), that pull request is `MERGED`, and the merge commit OID is an ancestor of the candidate head (`origin/<base>` or the recorded candidate). It SHALL return complete train evidence including `integrated_head_oid` set to that candidate. It SHALL NOT require an open pull request. It SHALL NOT require `Fixes #N` or `Closes #N` in the squash title.

When that observation succeeds, the coordinator SHALL NOT invoke train mutation (`runTrain` / `train --merge`) for those planned issues. Coordinator `next_action` SHALL be the first missing post-train phase (`frg_pack` when FRG pack evidence is absent). It SHALL NOT leave `next_action` at `train_merge` with `train: null` solely because GitHub recorded `willCloseTarget: false` for a `(#N)` squash mention.

#### Scenario: Merged (#N) pipeline PRs complete observeTrain

- **WHEN** a ship milestone plan is issues 1258, 1259, and 1252
- **AND** each issue's timeline has a `CrossReferencedEvent` with `willCloseTarget: false` to a merged same-repo pipeline pull request
- **AND** each merge commit OID is an ancestor of `origin/main`
- **THEN** train observation SHALL return complete train evidence
- **AND** that evidence SHALL include `integrated_head_oid` equal to the candidate head
- **AND** it SHALL NOT return null

#### Scenario: Successful observation does not re-enter train

- **WHEN** train observation returns complete evidence for the planned issues
- **THEN** ship SHALL NOT invoke `runTrain`
- **AND** it SHALL NOT STOP with `ready-to-deploy but has no linked open PR`

#### Scenario: Closing-keyword and ConnectedEvent paths still prove integration

- **WHEN** a planned issue's timeline has a `ConnectedEvent` or a `CrossReferencedEvent` with `willCloseTarget: true` to a merged same-repo pull request whose merge OID is an ancestor of the candidate
- **THEN** train observation SHALL return complete train evidence for that issue
- **AND** ship SHALL continue as for the `(#N)` path

#### Scenario: Fork PRs are not integration proof

- **WHEN** the only timeline link for a planned issue is a fork pull request (`isCrossRepository: true`)
- **THEN** train observation SHALL NOT treat that issue as integrated
- **AND** it SHALL NOT return complete train evidence for the plan

#### Scenario: After observation, next_action is FRG not train_merge

- **WHEN** train observation returns complete evidence and no later ship phase has run
- **THEN** coordinator `next_action` SHALL be `frg_pack` (or a later post-train phase if FRG evidence already exists)
- **AND** it SHALL NOT remain `train_merge` with `train: null` and `complete: false`
