## REMOVED Requirements

### Requirement: The generated plugin mirror SHALL carry the same dependency floor and resolution

**Reason:** #1048 retires the committed plugin core mirror, so dependency-floor ownership no longer belongs to that generated copy.

**Migration:** The core manifests remain authoritative and the installed CLI tree receives the same `core/` at install time.

## ADDED Requirements

### Requirement: The installed CLI tree SHALL carry the core dependency floor and resolution

The `js-yaml` floor and lockfile resolution SHALL be enforced on `core/package.json` and `core/package-lock.json`. The installed CLI tree SHALL receive that same `core/` at install time. A committed `plugin/pipeline/skills/pipeline/core/` copy SHALL NOT be required to carry the floor. `node scripts/build.mjs --check` SHALL NOT report a missing or drifted `plugin/` core lockfile as staleness. Dual-ship of a plugin core lockfile is forbidden.

#### Scenario: Build freshness does not require a duplicate core manifest

- **WHEN** `node scripts/build.mjs` runs and `node scripts/build.mjs --check` follows
- **THEN** `--check` SHALL exit zero without requiring `plugin/pipeline/skills/pipeline/core/package.json` to exist
- **AND** SHALL NOT require `plugin/pipeline/skills/pipeline/core/package-lock.json` to resolve `js-yaml`

#### Scenario: Core dependency enforcement remains single-sourced

- **WHEN** `core/package.json` or `core/package-lock.json` is bumped
- **THEN** `node scripts/build.mjs --check` SHALL NOT fail solely because a `plugin/` core copy was not regenerated
- **AND** `cd core && npm test` SHALL still enforce the `js-yaml` floor on `core/`

## MODIFIED Requirements

### Requirement: Config YAML parsing behavior SHALL be unchanged by the version bump

Raising the parser version SHALL NOT change any observable config behavior. The same
`.github/pipeline.yml` document SHALL resolve to the same configuration, strict-schema rejections
SHALL still name the offending key, and a malformed document SHALL still produce a config diagnostic
carrying a 1-based line number derived from the parse exception's `mark.line`. No file under
`core/scripts/` SHALL change as part of the bump.

#### Scenario: Valid config resolves identically

- **WHEN** a `.github/pipeline.yml` that resolved successfully before the bump is resolved after it
- **THEN** `resolveConfig()` SHALL return the same effective configuration values

#### Scenario: Malformed YAML still yields a located diagnostic

- **WHEN** `.github/pipeline.yml` contains a YAML syntax error
- **THEN** the config diagnostic SHALL report a 1-based line number for the error rather than
  throwing an unhandled exception

#### Scenario: Engine sources are untouched

- **WHEN** the diff for this change is inspected
- **THEN** it SHALL contain no modification under `core/scripts/`
- **AND** it SHALL be limited to the core manifests, generated SKILL/catalog outputs, the new
  floor-guard test, and OpenSpec artifacts
