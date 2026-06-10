## MODIFIED Requirements

### Requirement: Disabling docs skips the docs-update sub-step
When `cfg.steps.docs` is `true`, the implementing prompt SHALL include an explicit documentation-update instruction directing the implementer to update affected docs files (README, CLAUDE.md, config docs, etc.) as part of the same change. When `cfg.steps.docs` is `false`, the implementing prompt SHALL NOT include this instruction and the implementer SHALL make no documentation-update attempt. The pre-merge stage SHALL NOT invoke any docs-update harness regardless of `cfg.steps.docs`.

#### Scenario: docs enabled — implementing prompt includes docs instruction
- **WHEN** `cfg.steps.docs` is `true`
- **THEN** the implementing prompt SHALL contain a documentation-update instruction section
- **AND** the implementer SHALL update affected documentation files as part of the same commit(s)
- **AND** pre-merge SHALL NOT run a separate docs harness call and SHALL NOT push a docs-only commit

#### Scenario: docs disabled — implementing prompt omits docs instruction
- **WHEN** `cfg.steps.docs` is `false`
- **THEN** the implementing prompt SHALL NOT contain any documentation-update instruction
- **AND** pre-merge SHALL NOT invoke the docs-update harness or push documentation commits
- **AND** SHALL proceed directly to the CI/mergeability gates
