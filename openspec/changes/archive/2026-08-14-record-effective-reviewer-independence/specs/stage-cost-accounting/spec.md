## ADDED Requirements

### Requirement: Reviewer accounting SHALL distinguish requested, attempted, completed, and billable work

When the pipeline emits stage accounting for a review round on the shared reviewer seam, it SHALL record dimensions that distinguish **requested** reviewer slots (configured agents for the round), **attempted** invokes (started), **completed** invokes (terminal harness result), and **billable** invokes (completed with known actual or estimated cost under existing cost_source rules). Unknown cost SHALL use `cost_source: "unknown"` and `cost_usd: null` and SHALL NOT fabricate a billable zero actual. Ensemble rounds SHALL attribute per-agent accounting when agent identity is available; single-reviewer rounds SHALL use the same four dimensions with requested 1 when one reviewer is configured.

#### Scenario: ensemble rollup separates requested from billable

- **WHEN** three agents are configured, three are attempted, two complete with known cost, and one times out with unknown cost
- **THEN** requested SHALL be 3
- **AND** attempted SHALL be 3
- **AND** completed SHALL be 3
- **AND** billable SHALL be 2

#### Scenario: unknown cost is not billable zero

- **WHEN** a completed reviewer invoke has no actual or estimated cost
- **THEN** its accounting record SHALL use cost_source unknown and cost_usd null
- **AND** it SHALL NOT be counted as billable with cost_usd 0 as an actual

#### Scenario: accounting remains observational for routing

- **WHEN** two otherwise identical runs differ only in billable USD totals
- **THEN** stage transition decisions SHALL remain identical
- **AND** coverage block decisions SHALL depend on independence/quorum rules, not on USD totals alone
