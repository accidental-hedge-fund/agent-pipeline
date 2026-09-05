## MODIFIED Requirements

### Requirement: A linked merged PR SHALL be recognized as remote mutation of this issue

Before opening a successor PR, rebasing the candidate, or treating advance as still needed, reconciliation SHALL observe every pull request linked to the issue, including closed and merged PRs, and SHALL classify each PR's role and exact candidate binding. A merged-and-contained implementation PR for the current implementation candidate SHALL prove that integration side effect `known_complete`. A merged planning or specification PR SHALL prove only that planning artifact's integration; it SHALL NOT prove implementation, satisfy an implementing-stage postcondition, move an actionable item to `merged`, or complete its Logical Operation. An unclassified or ambiguously bound linked PR SHALL fail closed rather than being assumed to be the implementation candidate.

The current authoritative issue stage SHALL remain part of reconciliation. When an issue is open at `pipeline:ready` or another actionable stage and no exact implementation postcondition is proved, RecoverySupervisor SHALL keep the operation owned and resume or schedule the missing stage even if an older linked planning PR is merged. Reconciliation SHALL NOT open a successor PR on the same exact implementation branch or replay commits already proved contained for that implementation candidate.

#### Scenario: Forge squash-merge while still fix-2 is not replayed

- **WHEN** the issue is labeled at a post-implementation stage
- **AND** the exact linked implementation PR is squash-merged and its merge result is contained in the fetched base
- **THEN** reconciliation SHALL treat the implementation integration side effect as `known_complete`
- **AND** SHALL NOT open a second PR on that branch or rebase contained implementation commits

#### Scenario: Merged planning PR does not complete reopened ready issue

- **WHEN** an issue is open at `pipeline:ready`
- **AND** an older linked planning or specification PR is merged and contained
- **AND** no exact implementation-candidate postcondition is proved
- **THEN** reconciliation SHALL NOT project the item as `merged` or complete
- **AND** RecoverySupervisor SHALL retain ownership and schedule the actionable delivery work

#### Scenario: Latest open PR does not hide a prior merge

- **WHEN** a later open PR exists on the same implementation branch
- **AND** an earlier PR for the same exact implementation candidate is merged and contained
- **THEN** reconciliation SHALL still treat that implementation integration side effect as `known_complete`
- **AND** SHALL NOT consult only the latest open PR as authority

#### Scenario: Truncated linked-PR enumeration is not absence

- **WHEN** linked-PR enumeration is truncated, a detail read fails, or role/candidate binding cannot be proved
- **AND** no exact merged-and-contained implementation candidate is authoritatively observed
- **THEN** integration side-effect certainty SHALL be `uncertain`
- **AND** implementation completion, successor publication, and replay SHALL remain disallowed

#### Scenario: Failed linked-PR detail reads are not absence

- **WHEN** linked-PR numbers are enumerated
- **AND** a detail or role-binding read for any enumerated PR fails
- **AND** no exact merged-and-contained implementation candidate is authoritatively observed
- **THEN** integration side-effect certainty SHALL be `uncertain`
- **AND** SHALL NOT be `known_absent` or `known_complete`
- **AND** successor publication and implementation replay SHALL remain disallowed

## ADDED Requirements

### Requirement: Reconciliation completion SHALL be exact in operation, role, candidate, and epoch

Recovery and reconciliation SHALL mark a stage or Logical Operation complete only when its declared authoritative observer proves the required postcondition for the same operation identity, artifact role, exact candidate, and Candidate epoch. Process exit, admission stamp, local ledger state, issue label, comment, version string, or an unrelated merged PR SHALL be ingress or provenance evidence only. A recovery recipe SHALL NOT itself prove completion.

#### Scenario: Planning evidence cannot satisfy implementing

- **WHEN** the observer proves a planning artifact exists or its PR is merged
- **AND** the admitted operation requires the implementing-stage postcondition
- **THEN** completion certainty SHALL NOT be `known_complete`
- **AND** implementation work SHALL remain owned

#### Scenario: Exact implementation postcondition completes original operation once

- **WHEN** a later observer proves the exact current implementation candidate satisfies the admitted implementing postcondition
- **THEN** that proof SHALL complete the original Logical Operation at most once
- **AND** SHALL NOT mint a replacement Logical Operation or replay completed implementation
