## ADDED Requirements

### Requirement: Soft composition coverage MAY guard stale-block resume before train STOP

In addition to product stale-block resume contracts, the ship-path composition suite MAY include automated coverage that fails when leftover `pipeline:blocked` with newer non-pipeline-internal HEAD movement past the blocking reviewed-sha causes train or loop to terminal-STOP without one stale-block resume / re-review attempt on that advance. This composition class is soft relative to train-frontier, scratch-only, and independent R2D merge composition: it MAY be waived with an open tracking issue in the composition inventory without blocking those hard classes. When covered, tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls. Security denylist and true human-authority residual handling SHALL remain unchanged.

#### Scenario: Covered soft class fails on STOP before resume

- **WHEN** the soft composition class is registered with a covering test
- **AND** stale blocked + non-internal HEAD movement conditions hold under the product contract
- **AND** the system under test terminal-STOPs without attempting stale-block resume/re-review
- **THEN** the covering test SHALL fail

#### Scenario: Soft waiver does not weaken hard ship-path composition

- **WHEN** the soft class is waived with an open tracking issue
- **THEN** train-frontier, scratch-only, and independent R2D merge composition tests SHALL still be required
- **AND** security denylist and human-authority classes SHALL remain unweakened
