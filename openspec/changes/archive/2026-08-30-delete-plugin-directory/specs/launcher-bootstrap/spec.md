## REMOVED Requirements

### Requirement: Installer SHALL stage ensure-engines-node.mjs and the generated plugin shell SHALL delegate to that managed install

**Reason:** The generated plugin shell is deleted with `plugin/`. A marketplace bridge under `plugin/` is a stub.

**Migration:** The installer still stages `ensure-engines-node.mjs` next to the managed launcher. There is no repo plugin-shell launcher.

## ADDED Requirements

### Requirement: Installer SHALL stage ensure-engines-node.mjs next to the managed launcher

`scripts/install.mjs` SHALL copy `scripts/ensure-engines-node.mjs` into the managed skill `scripts/` directory next to the generated `pipeline.mjs` so the installed launcher can resolve the module it loads. The repository SHALL NOT keep a marketplace plugin-shell launcher that loads an adjacent engine or delegates from `plugin/`. `scripts/build.mjs` SHALL NOT write a resolver asset or bridge launcher under `plugin/`.

#### Scenario: Installed skill tree can resolve the resolver module

- **WHEN** the installer stages a host skill tree
- **THEN** `…/skills/pipeline/scripts/ensure-engines-node.mjs` SHALL exist
- **AND** the generated `pipeline.mjs` in that same directory SHALL be able to load it

#### Scenario: Build does not write a plugin-shell resolver

- **WHEN** `node scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/skills/pipeline/scripts/ensure-engines-node.mjs`
- **AND** it SHALL NOT write `plugin/pipeline/skills/pipeline/scripts/pipeline.mjs`
- **AND** `plugin/` SHALL NOT exist or be required

#### Scenario: Repo template --version still works without the installed layout

- **WHEN** `node hosts/_shared/entry.template.mjs --version` runs from the repository (not an installed skill tree)
- **THEN** it SHALL still print the package version and exit 0
- **AND** it SHALL NOT fail module load solely because `ensure-engines-node.mjs` is not a sibling of the template
