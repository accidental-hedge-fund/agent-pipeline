## ADDED Requirements

### Requirement: pipeline doctor SHALL include an install:version-coherence check

The `pipeline doctor` command SHALL include an `install:version-coherence` preflight check. The check SHALL read the `version` field from `core/package.json` at the install root (derived from the running module's `import.meta.url`) and compare it to the `VERSION` constant that `pipeline.ts` loaded at startup. If the two strings are identical the check SHALL pass; if they differ or `core/package.json` cannot be read the check SHALL fail.

#### Scenario: Versions match — check passes and reports install path

- **WHEN** `pipeline doctor` runs and the `version` field in `core/package.json` at the install root equals the `VERSION` constant loaded at startup
- **THEN** the `install:version-coherence` check SHALL have status `"pass"`
- **AND** the detail string SHALL include the version string (e.g., `v1.2.1`) and the install root path

#### Scenario: Versions differ — check fails with both versions named

- **WHEN** `pipeline doctor` runs and the `version` field in `core/package.json` at the install root does not equal the `VERSION` constant loaded at startup
- **THEN** the `install:version-coherence` check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the loaded version and the on-disk version
- **AND** the detail string SHALL include the install root path

#### Scenario: core/package.json is unreadable — check fails with remediation

- **WHEN** `pipeline doctor` runs and `core/package.json` at the install root cannot be read (missing or malformed)
- **THEN** the `install:version-coherence` check SHALL have status `"fail"`
- **AND** the remediation text SHALL instruct the user to reinstall the pipeline skill

### Requirement: The launcher SHALL surface the install:version-coherence failure for a corrupt install, honoring doctor's machine-output contracts

When `core/package.json` at the install root is missing or malformed, Node throws `ERR_INVALID_PACKAGE_CONFIG` while loading **any** TypeScript entry (`pipeline.ts` or the dependency-free `path-cli.ts`) — before that code can run. The pipeline launcher (`scripts/pipeline-launcher.mjs`) and the generated host shim (from `hosts/_shared/entry.template.mjs`) SHALL detect this corrupt-install case up front and emit the `install:version-coherence` failure with reinstall remediation themselves, exiting non-zero. This guard SHALL run before any path that spawns a TypeScript entry — specifically ahead of the `path` discovery fast-path and ahead of the `core/node_modules` dependency check — so that every command (including `path --json` and a corrupt install that also lacks dependencies) reports a coherent diagnostic rather than a raw Node stack trace or a generic runtime-dependencies error. The only command exempt from this guard is `--version`, which has its own corrupt-install handling. For the `doctor` command the launcher SHALL honor doctor's machine-output contracts: `--json` emits the stable JSON envelope, `--is-ok` emits zero output, and plain `doctor` emits human-readable prose.

#### Scenario: Malformed core/package.json — plain `doctor` prose surfaces the failure

- **WHEN** the launcher runs `doctor` and `core/package.json` at the install root is malformed
- **THEN** it SHALL exit non-zero
- **AND** stdout SHALL contain a human-readable report naming `install:version-coherence` and a reinstall remediation

#### Scenario: Malformed core/package.json — `doctor --json` emits the stable envelope

- **WHEN** the launcher runs `doctor --json` and `core/package.json` at the install root is malformed
- **THEN** stdout SHALL be a single parseable JSON envelope with `schema_version` `"1"` and `status` `"error"`
- **AND** the envelope SHALL include an `install:version-coherence` check whose `ok` is `false` and whose `fix` is a non-empty reinstall remediation

#### Scenario: Malformed core/package.json — `doctor --is-ok` is a silent exit-code gate

- **WHEN** the launcher runs `doctor --is-ok` and `core/package.json` at the install root is malformed
- **THEN** it SHALL write zero bytes to stdout and stderr
- **AND** it SHALL exit non-zero

#### Scenario: Corrupt install also missing node_modules — version-coherence still reported

- **WHEN** the launcher runs `doctor`, `core/package.json` at the install root is malformed, and `core/node_modules` is absent
- **THEN** it SHALL report the `install:version-coherence` failure
- **AND** it SHALL NOT report a generic runtime-dependencies error

#### Scenario: Malformed core/package.json — `path` fast-path yields a coherent diagnostic

- **WHEN** the launcher runs `path --json` and `core/package.json` at the install root is malformed
- **THEN** it SHALL exit non-zero with the corrupt-install reinstall diagnostic
- **AND** it SHALL NOT leak a raw `ERR_INVALID_PACKAGE_CONFIG` Node error from spawning `path-cli.ts`

### Requirement: The install:version-coherence check SHALL be unit-testable via injectable deps

The check implementation SHALL derive the install root path from a parameter (not from a module-level `import.meta.url` call inlined into the check body), and SHALL read `core/package.json` via the `DoctorDeps.readTextFile` primitive. This allows unit tests to supply a fake install root and a fake file reader without touching the real filesystem.

#### Scenario: Fake install root and fake file content — deterministic outcome

- **WHEN** a unit test calls `buildPreflightChecks` with an injected `installRoot` path and a `DoctorDeps` whose `readTextFile` returns a controlled JSON string
- **THEN** the `install:version-coherence` check SHALL produce the expected pass or fail result based solely on the injected inputs, with no real filesystem access

### Requirement: buildPreflightChecks SHALL accept the running version as an explicit argument

The `buildPreflightChecks` function SHALL accept the `version` string (the `VERSION` constant) as a second parameter so that unit tests can supply an arbitrary version without importing from `pipeline.ts`. The call site in `pipeline.ts` SHALL pass the `VERSION` constant.

#### Scenario: buildPreflightChecks called with a specific version string

- **WHEN** `buildPreflightChecks(config, "1.2.3")` is called
- **THEN** the resulting `install:version-coherence` check SHALL compare against `"1.2.3"` as the expected version

### Requirement: DoctorDeps SHALL expose readTextFile

The `DoctorDeps` interface SHALL include a `readTextFile(p: string): Promise<string | null>` method. The method SHALL return the file contents as a UTF-8 string on success, or `null` on any read error (missing file, permission error, etc.). The real implementation SHALL use `fs.promises.readFile(p, "utf8")` and catch all errors.

#### Scenario: readTextFile returns content for an existing file

- **WHEN** the real `DoctorDeps.readTextFile` is called with the path to an existing readable file
- **THEN** it SHALL return the file's UTF-8 contents as a string

#### Scenario: readTextFile returns null for a missing file

- **WHEN** the real `DoctorDeps.readTextFile` is called with a path that does not exist
- **THEN** it SHALL return `null` without throwing
