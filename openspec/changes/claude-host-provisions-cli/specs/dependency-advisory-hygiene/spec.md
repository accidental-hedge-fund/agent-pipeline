## MODIFIED Requirements

### Requirement: The generated plugin mirror SHALL carry the same dependency floor and resolution

The `js-yaml` floor and lockfile resolution SHALL be enforced on `core/package.json` and `core/package-lock.json`. The installed CLI tree SHALL receive that same `core/` at install time. A committed `plugin/pipeline/skills/pipeline/core/` copy SHALL NOT be required to carry the floor. `node scripts/build.mjs --check` SHALL NOT report a missing or drifted `plugin/` core lockfile as staleness. Dual-ship of a plugin core lockfile is forbidden.

#### Scenario: Mirror agrees with core after regeneration

- **WHEN** `node scripts/build.mjs` runs and `node scripts/build.mjs --check` follows
- **THEN** `--check` SHALL exit zero without requiring `plugin/pipeline/skills/pipeline/core/package.json` to exist
- **AND** SHALL NOT require `plugin/pipeline/skills/pipeline/core/package-lock.json` to resolve `js-yaml`

#### Scenario: A stale mirror blocks the change

- **WHEN** `core/package.json` or `core/package-lock.json` is bumped
- **THEN** `node scripts/build.mjs --check` SHALL NOT fail solely because a `plugin/` core copy was not regenerated
- **AND** `cd core && npm test` SHALL still enforce the `js-yaml` floor on `core/`
