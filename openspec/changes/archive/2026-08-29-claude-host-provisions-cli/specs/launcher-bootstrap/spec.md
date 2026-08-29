## REMOVED Requirements

### Requirement: Installer and plugin mirror SHALL stage ensure-engines-node.mjs next to the shim

**Reason:** Issue #1048 retires the committed plugin core mirror while preserving the generated SKILL shell and its launcher support files.

**Migration:** Installer-managed skill trees stage `ensure-engines-node.mjs` beside the engine launcher. The generated plugin shell delegates to that managed install and no longer carries `core/`.

## ADDED Requirements

### Requirement: Installer SHALL stage ensure-engines-node.mjs and the generated plugin shell SHALL delegate to that managed install

`scripts/install.mjs` SHALL copy `scripts/ensure-engines-node.mjs` into the managed skill `scripts/` directory next to the generated `pipeline.mjs` so the installed launcher can resolve the module it loads. The generated marketplace plugin shell SHALL NOT load an adjacent engine or require a copied `core/`; its launcher SHALL require the installer ownership marker and delegate exact argv to the managed Claude launcher. `scripts/build.mjs` MAY retain a transitional resolver asset in the plugin shell until #1050, but the marketplace bridge SHALL NOT claim to load it.

#### Scenario: Installed skill tree can resolve the resolver module

- **WHEN** the installer stages a host skill tree
- **THEN** `…/skills/pipeline/scripts/ensure-engines-node.mjs` SHALL exist
- **AND** the generated `pipeline.mjs` in that same directory SHALL be able to load it

#### Scenario: Generated plugin shell delegates without a core copy

- **WHEN** `node scripts/build.mjs` generates the plugin SKILL shell
- **THEN** its `pipeline.mjs` SHALL delegate exact argv to an installer-managed Claude launcher
- **AND** it SHALL fail with install remediation when that managed launcher or ownership marker is absent
- **AND** `plugin/pipeline/skills/pipeline/core/` SHALL NOT exist or be required

#### Scenario: Repo template --version still works without the installed layout

- **WHEN** `node hosts/_shared/entry.template.mjs --version` runs from the repository (not an installed skill tree)
- **THEN** it SHALL still print the package version and exit 0
- **AND** it SHALL NOT fail module load solely because `ensure-engines-node.mjs` is not a sibling of the template
