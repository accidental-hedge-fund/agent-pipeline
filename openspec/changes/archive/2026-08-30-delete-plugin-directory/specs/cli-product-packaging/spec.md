## MODIFIED Requirements

### Requirement: Contributor docs SHALL present install CLI plus short SKILL, not copy core

Contributor-facing packaging docs (at least `docs/packaging.md`, and README Development when it speaks about how the product is consumed) SHALL present the contributor path as installing the `pipeline` CLI plus a short host SKILL that execs that CLI. Those docs SHALL NOT present copying `core/` into a committed plugin mirror, or treating a committed `plugin/` directory, as the product distribution. They SHALL NOT describe a remaining generated `plugin/` SKILL overlay or marketplace shell. They SHALL tell an operator whose `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy to run `install --host claude` or pin.

#### Scenario: Contributor path names CLI plus SKILL

- **WHEN** a contributor reads `docs/packaging.md` for how to consume the product
- **THEN** the page SHALL tell them to install the CLI and a short host SKILL
- **AND** it SHALL NOT tell them to copy `core/` as the product

#### Scenario: plugin/ is transitional, not the product

- **WHEN** `docs/packaging.md` mentions `plugin/`
- **THEN** it SHALL describe `plugin/` as deleted / retired, not as a generated overlay that still ships
- **AND** it SHALL NOT describe `plugin/` as the distribution product

#### Scenario: leftover CLAUDE_PLUGIN_ROOT migration is documented

- **WHEN** a reader looks for how to leave a leftover marketplace core copy
- **THEN** packaging or install docs SHALL name `install --host claude` or pin as the remediation
