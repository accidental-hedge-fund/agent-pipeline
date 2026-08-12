## ADDED Requirements

### Requirement: Chain ship playbook SHALL NOT be the primary Option 1 Buzz ship path

When documentation describes Option 1 thin ship for agent-box / Buzz (`Ship milestone vX.Y.Z`), it SHALL name Tugboat as the primary composer. The chain-to-existing-tools playbook (`pipeline-ship-playbook`) MAY remain documented as an alternate composition for hosts that still install it, but Option 1 primary install and Hermes phrase mapping SHALL NOT present the playbook as the default Buzz ship path in competition with Tugboat.

#### Scenario: Option 1 docs de-primary the playbook

- **WHEN** an operator reads Option 1 ship install or Hermes ship-phrase documentation after this change
- **THEN** the primary path SHALL be Tugboat
- **AND** any remaining playbook instructions SHALL be labeled alternate/legacy (or equivalent) rather than the sole recommended Buzz path

#### Scenario: Playbook-specific doctor checks remain for hosts that still install it

- **WHEN** a host still has an installed `pipeline-ship-playbook` with a legacy codex-only promote default and no `ENGINE_PROMOTE_HOST` override
- **THEN** the existing `supervisor:ship-playbook-promote-host` doctor check SHALL continue to fail closed
- **AND** that check SHALL NOT be removed solely because Tugboat is primary
