## ADDED Requirements

### Requirement: implementation-ci recovery for no-commits SHALL try shared HEAD goal satisfaction first

When a blocked item’s diagnostic projects `no-commits` (or an equivalent implementation-outcome block) into the `implementation-ci` recovery class, the autonomous recovery controller’s policy for that class SHALL include a **deterministic first recipe** that invokes the shared `noop-advance-contract` evaluation with the **current stage’s** goal checks against the claimed HEAD. For implement-stage goal checks, the recipe SHALL verify the declared deliverable and worktree cleanliness via injectable deterministic probes (not hard-coded true). When evaluation returns **advance**, the controller SHALL **first** record attested durable evidence, and only then redispatch or clear the mechanical block — and SHALL **not** charge model-repair (`repair_pipeline_item` or equivalent) budget for that successful recipe. When evaluation returns **escalate**, goal checks cannot run, the worktree is dirty, or durable evidence cannot be recorded, the controller SHALL proceed to the next configured recipe for the class (including model repair when permitted) or typed exhaustion — fail closed, **without** clearing the block as repaired by this recipe. The recipe SHALL NOT add a recovery-only marker that bypasses normal product gates, and SHALL use the same verifier as normal stage execution (no parallel private satisfaction algorithm).

#### Scenario: First recipe is goal satisfaction for no-commits implementation-ci

- **WHEN** fresh reconciliation classifies a `no-commits` block as `implementation-ci` with recovery budget remaining
- **THEN** the controller SHALL claim and execute the shared goal-satisfaction recipe before model-repair recipes for that class
- **AND** the recipe SHALL call the shared noop-advance evaluation used by stage execution

#### Scenario: Satisfied HEAD advances without model-repair budget

- **WHEN** the goal-satisfaction recipe runs, the worktree is clean, the stage goal check is satisfied, and durable evidence is recorded
- **THEN** the controller SHALL continue/redispatch
- **AND** SHALL NOT decrement model-repair budget for that successful goal-satisfaction recipe

#### Scenario: Unsatisfied HEAD does not falsely clear the block

- **WHEN** the goal-satisfaction recipe runs and the shared evaluation returns **escalate**
- **THEN** the controller SHALL NOT mark the item repaired solely by this recipe
- **AND** SHALL advance to the next configured recipe or exhaust fail-closed under existing policy
- **AND** SHALL NOT bypass format, test, CI, OpenSpec, or review gates on subsequent paths

#### Scenario: Dirty worktree does not certify implement goal satisfaction

- **WHEN** the goal-satisfaction recipe runs for an implementing-stage no-commits block and the worktree is not clean
- **THEN** the recipe SHALL fail closed without clearing the blocked label
- **AND** SHALL NOT hard-code worktree cleanliness as true

#### Scenario: Evidence write failure preserves the block

- **WHEN** the shared evaluation returns **advance** but posting the attested evidence note fails
- **THEN** the recipe SHALL fail closed and SHALL NOT clear the blocked label
