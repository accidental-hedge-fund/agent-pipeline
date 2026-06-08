## ADDED Requirements

### Requirement: Spec deltas available to plan-review step
When OpenSpec is active, the plan-review harness prompt SHALL include the active change's spec deltas so the reviewer can assess whether the plan satisfies the intended behavior.

#### Scenario: Plan-review receives spec deltas in OpenSpec run
- **WHEN** the pipeline runs plan-review and OpenSpec is active with at least one change
- **THEN** the plan-review prompt contains the spec deltas from `openspec/changes/<name>/specs/`

#### Scenario: Plan-review unaffected when OpenSpec is inactive
- **WHEN** the pipeline runs plan-review and no OpenSpec change is active
- **THEN** the plan-review prompt is identical to a non-OpenSpec run (no spec section added)

### Requirement: Spec deltas available to plan-revision step
When OpenSpec is active, the plan-revision harness prompt SHALL include the active change's spec deltas so revisions are grounded in the requirements the plan must satisfy.

#### Scenario: Plan-revision receives spec deltas in OpenSpec run
- **WHEN** the pipeline runs plan-revision and OpenSpec is active with at least one change
- **THEN** the plan-revision prompt contains the spec deltas from `openspec/changes/<name>/specs/`

#### Scenario: Plan-revision unaffected when OpenSpec is inactive
- **WHEN** the pipeline runs plan-revision and no OpenSpec change is active
- **THEN** the plan-revision prompt is identical to a non-OpenSpec run (no spec section added)

### Requirement: Spec deltas available to implementing step
When OpenSpec is active, the implementing harness prompt SHALL include the active change's spec deltas alongside the proposal and tasks, so the implementer can verify that the work satisfies the stated requirements.

#### Scenario: Implementing receives spec deltas in OpenSpec run
- **WHEN** the pipeline runs the implementing step and OpenSpec is active with at least one change
- **THEN** the implementing prompt contains the spec deltas from `openspec/changes/<name>/specs/`

#### Scenario: Implementing unaffected when OpenSpec is inactive
- **WHEN** the pipeline runs the implementing step and no OpenSpec change is active
- **THEN** the implementing prompt is identical to a non-OpenSpec run (no spec section added)

### Requirement: Spec deltas available to fix rounds
When OpenSpec is active, each fix-round harness prompt SHALL include the active change's spec deltas alongside the review findings, so fixes are guided by the original requirements and not solely by the review text.

#### Scenario: Fix round receives spec deltas in OpenSpec run
- **WHEN** the pipeline runs fix-1 or fix-2 and OpenSpec is active with at least one change
- **THEN** the fix prompt contains the spec deltas from `openspec/changes/<name>/specs/`

#### Scenario: Fix round unaffected when OpenSpec is inactive
- **WHEN** the pipeline runs fix-1 or fix-2 and no OpenSpec change is active
- **THEN** the fix prompt is identical to a non-OpenSpec run (no spec section added)

### Requirement: Review rounds unchanged
The standard and adversarial review round prompts SHALL continue to receive spec deltas exactly as before — no duplication, no regression, no change in how they load or render spec context.

#### Scenario: Review rounds continue to include spec deltas
- **WHEN** the pipeline runs review-1 or review-2 and OpenSpec is active
- **THEN** the review prompt includes the spec deltas exactly as it did before this change

### Requirement: Spec context helper is centrally defined
A single `openspecContext(cfg, cwd)` function SHALL exist in `openspec.ts` that returns the spec deltas string for the active change (or `""` when OpenSpec is not active or no changes exist). All pipeline stages SHALL call this shared function rather than duplicating the loading logic.

#### Scenario: openspecContext returns spec deltas when active
- **WHEN** `openspecContext(cfg, cwd)` is called and OpenSpec is active with at least one change containing spec files
- **THEN** it returns the concatenated spec delta content from `openspec/changes/<name>/specs/`

#### Scenario: openspecContext returns empty string when inactive
- **WHEN** `openspecContext(cfg, cwd)` is called and OpenSpec is not active or no changes exist
- **THEN** it returns `""`
