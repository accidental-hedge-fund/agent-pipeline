## REMOVED Requirements

### Requirement: Installer and plugin mirror SHALL stage ensure-engines-node.mjs next to the shim

**Reason:** Issue #1048 retires the committed plugin core mirror while preserving the generated SKILL shell and its launcher support files.

**Migration:** Installer-managed skill trees and the generated plugin SKILL shell continue to stage `ensure-engines-node.mjs` beside the launcher; the plugin shell no longer carries `core/`.

## ADDED Requirements

### Requirement: Installer and generated plugin shell SHALL stage ensure-engines-node.mjs next to the shim

`scripts/install.mjs` and `scripts/build.mjs` SHALL copy `scripts/ensure-engines-node.mjs` into the skill `scripts/` directory next to the generated `pipeline.mjs` so an installed skill tree (`…/skills/pipeline/scripts/`) and the generated plugin SKILL shell can resolve the module the shim loads. The plugin shell SHALL NOT contain a copy of `core/`.

#### Scenario: Installed skill tree can resolve the resolver module

- **WHEN** the installer stages a host skill tree
- **THEN** `…/skills/pipeline/scripts/ensure-engines-node.mjs` SHALL exist
- **AND** the generated `pipeline.mjs` in that same directory SHALL be able to load it

#### Scenario: Generated plugin shell stages the resolver module

- **WHEN** `node scripts/build.mjs` generates the plugin SKILL shell
- **THEN** `plugin/pipeline/skills/pipeline/scripts/ensure-engines-node.mjs` SHALL exist next to `pipeline.mjs`
- **AND** `plugin/pipeline/skills/pipeline/core/` SHALL NOT be required

#### Scenario: Repo template --version still works without the installed layout

- **WHEN** `node hosts/_shared/entry.template.mjs --version` runs from the repository (not an installed skill tree)
- **THEN** it SHALL still print the package version and exit 0
- **AND** it SHALL NOT fail module load solely because `ensure-engines-node.mjs` is not a sibling of the template
