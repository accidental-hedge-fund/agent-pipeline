## ADDED Requirements

### Requirement: Planning prompt SHALL mandate repo-pattern research before drafting

The planning prompt (`planning.md`) SHALL include a mandatory pre-draft instruction requiring the harness to read the files most directly relevant to the issue and identify the patterns they establish before writing the plan. The prompt SHALL require the plan's Approach section to cite at least one concrete pattern from the actual repo files — not generic advice derived only from the conventions excerpt.

#### Scenario: harness reads repo files before drafting

- **WHEN** the planning harness receives a planning prompt for an issue
- **THEN** the prompt SHALL instruct the harness to read relevant repo files before drafting
- **AND** the plan's Approach section SHALL cite at least one concrete repo pattern

#### Scenario: conventions excerpt alone is insufficient

- **WHEN** the planning prompt is rendered
- **THEN** the conventions excerpt SHALL be supplemented by an explicit instruction to read files in scope
- **AND** the harness SHALL NOT be expected to derive repo patterns solely from the conventions excerpt

### Requirement: Planning output SHALL include an explicit acceptance-criteria section

The planning prompt (`planning.md`) SHALL require the plan to include a `### Acceptance criteria` section containing a checkable list of observable outcomes that make the issue done. Each criterion SHALL be falsifiable — it must describe an observable behavior, not restate the implementation approach.

#### Scenario: plan includes acceptance criteria

- **WHEN** the planning harness completes a plan
- **THEN** the plan SHALL contain a `### Acceptance criteria` section
- **AND** the section SHALL contain at least one checkable item
- **AND** each item SHALL state an observable outcome (not merely a restatement of the approach)

#### Scenario: acceptance criteria are visible at plan-review time

- **WHEN** the plan-reviewer harness receives the plan for review
- **THEN** the acceptance criteria section SHALL be present in the plan text
- **AND** the reviewer MAY flag a plan with no acceptance criteria or with non-falsifiable criteria as insufficient

#### Scenario: OpenSpec mode also emits acceptance criteria

- **WHEN** the pipeline runs in OpenSpec mode and `planning_openspec.md` is used
- **THEN** the harness SHALL be instructed to include explicit acceptance criteria in the produced proposal
- **AND** the criteria format SHALL be consistent with the non-OpenSpec planning path

### Requirement: The change is prompt-only; no new harness calls on the default path

This capability SHALL be implemented entirely within the planning prompt text. The planning stage SHALL NOT add extra harness calls, pre-planning steps, fan-out research agents, or new configuration keys to support this capability. The harness's existing `bypassPermissions` access is sufficient for repo-file reading.

#### Scenario: no extra harness calls

- **WHEN** an issue advances through the planning stage with this change applied
- **THEN** the number of harness invocations in the planning stage SHALL be unchanged from before this change
- **AND** no new configuration key SHALL be required to enable repo-pattern research

#### Scenario: behavior is unchanged when files are not readable

- **WHEN** the harness cannot read a relevant file (e.g. it does not exist)
- **THEN** planning SHALL still produce a plan and SHALL NOT block the pipeline
