## ADDED Requirements

### Requirement: Inapplicable deterministic recipes SHALL NOT consume substantive repair budget

When RecoverySupervisor selects recipes named by this capability, it SHALL evaluate applicability from live evidence and declared invariants before claiming a recipe. An inapplicable deterministic recipe SHALL be recorded as a skip. It SHALL NOT consume the substantive repair budget of a later applicable recipe. `auto_recover` SHALL claim or resume the same Recovery Episode and SHALL NOT keep a private class-wide budget that hides later recipes.

#### Scenario: Inapplicable first recipe leaves repair reachable

- **WHEN** the configured order is a deterministic prep or verify recipe followed by `repair_pipeline_item`
- **AND** the first recipe's preconditions are false
- **THEN** RecoverySupervisor SHALL skip that recipe without charging `repair_pipeline_item`
- **AND** `repair_pipeline_item` SHALL remain reachable in production order

#### Scenario: auto_recover does not spend a private class-wide cap as authority

- **WHEN** `auto_recover` observes an inapplicable deterministic recipe
- **THEN** it SHALL record the skip on the Recovery Episode
- **AND** SHALL NOT decrement a private `auto_recovery_max_retries` or class-wide budget as the reason a later recipe is unreachable
