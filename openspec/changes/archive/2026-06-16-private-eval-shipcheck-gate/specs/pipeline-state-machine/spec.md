## MODIFIED Requirements

### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`
- **AND** `eval-gate` SHALL appear at an index greater than `pre-merge` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`

#### Scenario: dispatch routes eval-gate
- **WHEN** the current stage label is `pipeline:eval-gate`
- **THEN** the orchestrator SHALL call the eval stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: dispatch routes shipcheck-gate
- **WHEN** the current stage label is `pipeline:shipcheck-gate`
- **THEN** the orchestrator SHALL call the shipcheck stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly
