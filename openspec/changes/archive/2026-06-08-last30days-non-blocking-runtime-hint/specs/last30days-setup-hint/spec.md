## ADDED Requirements

### Requirement: Hint on skill unavailable
When `last30days.enabled` is true and `last30days.run()` returns `unavailable: true`, the pipeline SHALL emit a single non-blocking hint message that names the install command and states that data-source keys are configured in the skill, then SHALL proceed with planning as if carry-forward context is empty.

#### Scenario: Skill not installed, enabled true
- **WHEN** `last30days.enabled` is `true` in the pipeline config
- **AND** `last30days.run()` returns `{ unavailable: true }`
- **THEN** a hint message is logged indicating the skill is not found and providing install guidance
- **AND** `gatherCarryForward` returns `""` without blocking or throwing

#### Scenario: Hint not emitted when disabled
- **WHEN** `last30days.enabled` is `false` (or absent)
- **AND** `last30days.run()` would return `{ unavailable: true }` if called
- **THEN** no hint is emitted and `last30days.run()` is never called

### Requirement: Hint on no usable signal
When `last30days.enabled` is true and the skill ran successfully but `hasSignal(brief)` is false (or `res.success` is false), the pipeline SHALL emit a single non-blocking hint that names at least one data-source key configuration step and states that keys are managed in the skill, then SHALL proceed with planning as if carry-forward context is empty.

#### Scenario: Skill ran but returned no signal
- **WHEN** `last30days.enabled` is `true` in the pipeline config
- **AND** `last30days.run()` returns `{ unavailable: false, success: true, brief: "<low-signal content>" }`
- **AND** `last30days.hasSignal(brief)` returns `false`
- **THEN** a hint message is logged suggesting data-source key configuration in the skill
- **AND** `gatherCarryForward` returns `""` without blocking or throwing

#### Scenario: Skill failed (success: false)
- **WHEN** `last30days.enabled` is `true`
- **AND** `last30days.run()` returns `{ unavailable: false, success: false }`
- **THEN** a hint message is logged suggesting data-source key configuration
- **AND** `gatherCarryForward` returns `""` without blocking or throwing

### Requirement: No hint when last30days disabled
When `last30days.enabled` is false or absent, the pipeline SHALL emit no hint and SHALL NOT invoke `last30days.run()` at all. Existing behavior is unchanged.

#### Scenario: Default config (last30days.enabled absent or false)
- **WHEN** `last30days.enabled` is `false` or not set in config
- **THEN** `gatherCarryForward` returns `""` immediately
- **AND** no hint message is logged
- **AND** `last30days.run()` is never called

### Requirement: README documents data-source keys
The README "last30days context (optional)" section SHALL document that data-source keys are configured in the last30days skill (not the pipeline), SHALL name `BRAVE_SEARCH_API_KEY` (free) and `SCRAPECREATORS_API_KEY` (fuller social coverage) as the highest-lift keys, and SHALL provide a link to the skill's own setup documentation.

#### Scenario: User reads README to learn how to configure last30days
- **WHEN** a user reads the "last30days context (optional)" section of the README
- **THEN** they learn that keys are set in the skill, not the pipeline
- **AND** they learn which keys provide the most benefit
- **AND** they are given a link to the skill's setup guide
