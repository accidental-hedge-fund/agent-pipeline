## ADDED Requirements

### Requirement: Unblocked later-stage resume SHALL revalidate review currency on enter

Enter-path review-currency revalidation SHALL cover unblocked issues already labeled `pipeline:visual-gate`, `pipeline:eval-gate`, `pipeline:shipcheck-gate`, or `pipeline:ready-to-deploy`, not only leftover `pipeline:blocked` at pre-merge, fix, or review. Ordinary advance, nested whole-item advance, `pipeline single`, and durable loop recovery SHALL share that enter path. A missing `pipeline:blocked` label SHALL NOT skip revalidation. Leftover-block resume at pre-merge, fix, and review SHALL keep the existing stale-block contract.

#### Scenario: Unblocked visual-gate resume still revalidates

- **WHEN** an issue carries `pipeline:visual-gate` and does not carry `pipeline:blocked`
- **AND** PR HEAD has moved past the latest review SHA with a non-pipeline-internal commit
- **THEN** the next advance SHALL revalidate review currency on enter
- **AND** SHALL NOT treat the later-stage label as proof that review is current

#### Scenario: Blocked leftover at pre-merge stays on the existing resume path

- **WHEN** an issue carries `pipeline:blocked` at a stale-block-eligible pre-merge, fix, or review stage
- **THEN** the pipeline SHALL still run the existing stale-block resume evaluation
- **AND** this later-stage unblocked path SHALL NOT replace that contract
