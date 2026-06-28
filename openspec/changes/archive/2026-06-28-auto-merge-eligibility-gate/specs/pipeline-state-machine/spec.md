## ADDED Requirements

### Requirement: shipcheck-gate handler SHALL invoke the auto-merge eligibility gate when enabled
After completing its existing checks, the `shipcheck-gate` handler SHALL invoke the auto-merge eligibility gate module if `config.auto_merge_eligibility.enabled` is `true`. The eligibility gate runs inline inside `shipcheck-gate`; it does NOT introduce a new entry in the `STAGES` constant. The `shipcheck-gate` handler SHALL advance to `ready-to-deploy` regardless of the eligibility verdict — the gate produces a classification artifact only and does not block stage progression.

#### Scenario: eligibility gate runs inside shipcheck-gate when enabled
- **WHEN** the `shipcheck-gate` handler is dispatched
- **AND** `config.auto_merge_eligibility.enabled` is `true`
- **THEN** the handler SHALL call the eligibility gate module after all existing checks complete
- **AND** SHALL write the `auto_merge_eligibility` artifact to the evidence bundle
- **AND** SHALL still advance the issue to `ready-to-deploy` regardless of the eligibility verdict

#### Scenario: eligibility gate skipped inside shipcheck-gate when disabled
- **WHEN** the `shipcheck-gate` handler is dispatched
- **AND** `config.auto_merge_eligibility.enabled` is `false` (the default)
- **THEN** the handler SHALL NOT call the eligibility gate module
- **AND** SHALL advance to `ready-to-deploy` exactly as before

#### Scenario: eligibility gate error does not block ready-to-deploy
- **WHEN** the eligibility gate throws an unexpected error
- **THEN** the `shipcheck-gate` handler SHALL log the error
- **AND** SHALL still advance to `ready-to-deploy`
- **AND** SHALL NOT propagate the error as a stage failure
