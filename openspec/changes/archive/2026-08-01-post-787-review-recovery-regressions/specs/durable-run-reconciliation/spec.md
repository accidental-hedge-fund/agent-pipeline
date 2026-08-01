## ADDED Requirements

### Requirement: Blocked recovery SHALL outrank bare open-PR discovery
When the ledger records an item as `blocked`, a verified open PR alone SHALL NOT constitute
`ledger-behind` drift and SHALL NOT repair the item to `pr_opened`, regardless of the live pipeline
stage label. Reconciliation SHALL preserve the blocked state, its class, evidence, remaining budget,
and any `started` recovery attempt. Verified ready-to-deploy or merged truth SHALL continue to
supersede recovery through normal forward repair.

#### Scenario: Open PR and needs-human label preserve blocked recovery
- **WHEN** the ledger item is `blocked` with a started recovery attempt
- **AND** live observation reports an open PR and `pipeline:needs-human`
- **THEN** reconciliation SHALL record no `ledger-behind` drift from PR existence alone
- **AND** the item SHALL remain blocked with the same started attempt and budget

#### Scenario: Restart replays the same attempt
- **WHEN** a supervisor resumes the blocked item after the prior process stranded an attempt as `started`
- **AND** the same candidate PR remains open
- **THEN** the supervisor SHALL reconcile and re-enter that attempt identity
- **AND** SHALL NOT charge another attempt or replay a completed model side effect

#### Scenario: Ready truth supersedes blocked recovery
- **WHEN** a blocked item is freshly verified with the ready-to-deploy label
- **THEN** reconciliation SHALL repair the item forward to `ready`
- **AND** SHALL terminalize the obsolete started attempt as superseded

#### Scenario: Merged truth supersedes blocked recovery
- **WHEN** a blocked item is freshly verified with a merged PR
- **THEN** reconciliation SHALL repair the item forward to `merged`
