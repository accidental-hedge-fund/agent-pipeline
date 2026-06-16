## ADDED Requirements

### Requirement: Advance loop checks for pending approval checkpoint before dispatching each stage
Before the advance loop dispatches any stage, it SHALL evaluate whether that stage is listed in `config.approvalCheckpoints`. If it is, the loop SHALL inspect the issue's `pipeline:awaiting-approval` label (see `human-approval-checkpoints`) and either fire or pass the checkpoint before proceeding. A checkpoint that fires SHALL return `{ advanced: false, status: "waiting" }` and stop the loop; a cleared checkpoint (label absent) SHALL allow dispatch to proceed normally.

#### Scenario: advance loop stops at a checkpoint before dispatching
- **WHEN** the advance loop resolves the next stage as `implementing`
- **AND** `config.approvalCheckpoints` includes `"implementing"`
- **AND** the checkpoint fires (see `human-approval-checkpoints`)
- **THEN** the loop SHALL stop without dispatching any further stage
- **AND** the loop SHALL exit with `status: "waiting"` (same exit path as CI-polling waits)

#### Scenario: advance loop continues past a cleared checkpoint
- **WHEN** the advance loop resolves the next stage as `implementing`
- **AND** `config.approvalCheckpoints` includes `"implementing"`
- **AND** the `pipeline:awaiting-approval` label is absent (checkpoint cleared by human approval)
- **THEN** the loop SHALL dispatch the `implementing` stage handler normally
- **AND** the checkpoint SHALL NOT be re-issued
