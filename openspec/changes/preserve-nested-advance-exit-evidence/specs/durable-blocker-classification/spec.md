## ADDED Requirements

### Requirement: Nested-child process exits SHALL select process-lifecycle recovery

Recovery classification SHALL recognize nested-child process termination from structured diagnostic fields, not free-form prose. For that diagnostic, the workflow-engine recovery sequence SHALL select `restart_workflow_engine` and SHALL treat scratch cleanup, harness-dirt checkpointing, unpublished-commit publication, Tester evidence rebind, and product repair as inapplicable. Those inapplicable recipes SHALL NOT consume their per-strategy budgets.

#### Scenario: Structured nested-child exit routes directly to restart

- **WHEN** a workflow-engine diagnostic carries a nested-child exit code or signal
- **THEN** the applicable recovery recipes SHALL contain `restart_workflow_engine`
- **AND** no scratch, publication, Tester-rebind, or product-repair recipe SHALL be applicable

#### Scenario: Exit-like prose does not alter recovery selection

- **WHEN** a workflow-engine diagnostic mentions a child exit only in its free-form reason and omits structured process-exit evidence
- **THEN** recovery SHALL NOT infer the nested-child process-exit treatment from that prose
- **AND** ordinary workflow-engine diagnostic filtering SHALL continue to apply

#### Scenario: Malformed, impossible, or successful exit detail cannot narrow recovery

- **WHEN** process-exit detail reports exit code zero or outside 1–255, an unknown signal name, contradictory code and signal, or omits a required member
- **THEN** diagnostic projection SHALL reject that detail as a protocol failure
- **AND** recovery recipe filtering SHALL NOT select restart-only treatment from it

#### Scenario: Exit detail outside nested dispatch cannot narrow recovery

- **WHEN** process-exit detail appears on a diagnostic whose stage is not `loop-dispatch`, whose blocker kind is not `harness-failure`, or whose reason code is not `workflow-engine-defect`
- **THEN** diagnostic projection SHALL reject that context as a protocol failure
- **AND** workflow-engine recovery filtering SHALL NOT select restart-only treatment from it
