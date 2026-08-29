# dependency-advisory-hygiene Specification

## Purpose
TBD - created by archiving change js-yaml-dos-advisory-bump. Update Purpose after archive.
## Requirements
### Requirement: The core YAML parser dependency SHALL declare a floor at or above the advisory fix version

`core/package.json` SHALL declare its `js-yaml` dependency with a semver range whose lowest
satisfying version is **4.3.0 or higher**, and which stays within the `4.x` major line. 4.3.0 is the
fixed version for GHSA-h67p-54hq-rp68 (quadratic merge-key alias expansion, `>=4.0.0 <=4.1.1`) and
GHSA-52cp-r559-cp3m (merge-key chains forcing quadratic CPU, `>=4.0.0 <4.3.0`). The declared floor —
not merely the current lockfile pin — is the durable guarantee, because a range whose floor is below
the fix version permits a fresh install to resolve back into the vulnerable range.

#### Scenario: Declared range floor is at or above the fix version

- **WHEN** `core/package.json` is read
- **THEN** its `dependencies["js-yaml"]` range SHALL NOT be satisfied by any version below 4.3.0
- **AND** the range SHALL be satisfied by at least one version in the `4.x` major line

#### Scenario: A floor below the fix version is rejected

- **WHEN** `core/package.json` declares a `js-yaml` range whose lowest satisfying version is below
  4.3.0 (for example `^4.1.0`)
- **THEN** `cd core && npm test` SHALL fail with a message naming `js-yaml` and the required `>=4.3.0`
  floor

### Requirement: The lockfile SHALL resolve the YAML parser to a non-advisory version

`core/package-lock.json` SHALL resolve `node_modules/js-yaml` to a concrete version `>=4.3.0`, with
the registry `resolved` URL and `integrity` hash corresponding to that exact version. Installing
core's dependencies from the lockfile SHALL therefore never materialize a version in the advisory
range, and an `npm audit` over the installed tree SHALL report no advisory attributed to `js-yaml`.

#### Scenario: Lockfile resolution is at or above the fix version

- **WHEN** `core/package-lock.json` is read
- **THEN** the `node_modules/js-yaml` entry SHALL declare a `version` of 4.3.0 or higher
- **AND** its `resolved` URL and `integrity` hash SHALL correspond to that same version

#### Scenario: Installed tree is advisory-clean for the parser

- **WHEN** `cd core && npm ci` installs the locked tree and `npm audit` runs against it
- **THEN** the audit report SHALL contain no vulnerability entry whose package name is `js-yaml`
- **AND** neither GHSA-h67p-54hq-rp68 nor GHSA-52cp-r559-cp3m SHALL appear in the report

#### Scenario: A lockfile resolution below the fix version is rejected

- **WHEN** `core/package-lock.json` resolves `js-yaml` to a version below 4.3.0 (for example 4.1.1)
- **THEN** `cd core && npm test` SHALL fail with a message naming `js-yaml` and the resolved version

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
