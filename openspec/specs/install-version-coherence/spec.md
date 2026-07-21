# install-version-coherence Specification

## Purpose
TBD - created by archiving change version-staleness-detection. Update Purpose after archive.
## Requirements
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

When `core/package.json` at the install root is a **corrupt install config**, Node throws `ERR_INVALID_PACKAGE_CONFIG` while loading **any** TypeScript entry (`pipeline.ts` or the dependency-free `path-cli.ts`) — before that code can run. A corrupt install config is one that is missing, not valid JSON, OR valid JSON that nonetheless prevents the ESM-only `.ts` entries from loading: a non-object (e.g. a top-level array), a `version` that is not a string, or an explicit `type` other than `"module"` (e.g. `type: 123`, which trips `ERR_INVALID_PACKAGE_CONFIG`, or `type: "commonjs"`, under which the entries' ESM `import`s fail to load). An absent `type` is healthy — the `.ts` entries load as ESM. The pipeline launcher (`scripts/pipeline-launcher.mjs`) and the generated host shim (from `hosts/_shared/entry.template.mjs`) SHALL classify all of these as corrupt up front and emit the `install:version-coherence` failure with reinstall remediation themselves, exiting non-zero — they SHALL NOT treat a config as healthy merely because it parses as JSON. This guard SHALL run before any path that spawns a TypeScript entry — specifically ahead of the `path` discovery fast-path and ahead of the `core/node_modules` dependency check — so that every command (including `path --json` and a corrupt install that also lacks dependencies) reports a coherent diagnostic rather than a raw Node stack trace or a generic runtime-dependencies error. The only command exempt from this guard is `--version`, which has its own corrupt-install handling. For the `doctor` command the launcher SHALL honor doctor's machine-output contracts: `--json` emits the stable JSON envelope, `--is-ok` emits zero output, and plain `doctor` emits human-readable prose.

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

#### Scenario: Valid JSON but an ESM-incompatible package config — still classified as corrupt

- **WHEN** the launcher or host shim runs `path --json` or `doctor --json` and `core/package.json` at the install root is valid JSON that still prevents the `.ts` entries from loading (e.g. `{"version":"0.0.0","type":123}` or `{"version":"0.0.0","type":"commonjs"}`)
- **THEN** it SHALL classify the install as corrupt and surface the `install:version-coherence` diagnostic (a JSON envelope for `--json`, the reinstall hint otherwise)
- **AND** it SHALL NOT leak a raw `ERR_INVALID_PACKAGE_CONFIG` or `Cannot use import statement outside a module` Node error from spawning a TypeScript entry

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

### Requirement: `pipeline doctor` SHALL include a `loop:contract-coherence` check

The `pipeline doctor` command SHALL include a `loop:contract-coherence` preflight
check. The check SHALL discover the installed goal-loop skill, read its ownership
manifest (`.goal-loop-manifest.json`, which carries `package` and `version`) and the
contract/ledger schema ids it implements, and compare those schema ids against
Pipeline's supported-set constant. The check SHALL pass when a goal-loop install is
discovered whose schema ids are all in the supported set. It SHALL fail when no
goal-loop install is discovered, when the manifest cannot be read or parsed, or when
any discovered schema id is outside the supported set — including a schema id that is
*newer* than the supported set. A failure detail SHALL name both the discovered
version/schema ids and Pipeline's supported ids, and SHALL carry actionable
remediation.

#### Scenario: Supported goal-loop install — check passes

- **WHEN** `pipeline doctor` runs and the discovered goal-loop install reports a
  manifest version and contract/ledger schema ids that are all within Pipeline's
  supported set
- **THEN** the `loop:contract-coherence` check SHALL have status `"pass"`
- **AND** the detail string SHALL include the goal-loop version and the discovered
  contract schema id

#### Scenario: Unsupported contract schema — check fails naming both sides

- **WHEN** `pipeline doctor` runs and the discovered goal-loop implements a contract
  schema id outside Pipeline's supported set
- **THEN** the `loop:contract-coherence` check SHALL have status `"fail"`
- **AND** the detail string SHALL name both the discovered schema id and the supported
  schema id(s)
- **AND** the remediation SHALL instruct the user to align the goal-loop and Pipeline
  versions

#### Scenario: A newer-than-supported contract also fails

- **WHEN** the discovered goal-loop contract schema id is newer than any id in
  Pipeline's supported set
- **THEN** the check SHALL have status `"fail"` rather than passing optimistically

#### Scenario: goal-loop not installed — check fails with an install remediation

- **WHEN** `pipeline doctor` runs and no installed goal-loop skill or manifest can be
  discovered
- **THEN** the `loop:contract-coherence` check SHALL have status `"fail"`
- **AND** the remediation SHALL instruct the user to install goal-loop

---

### Requirement: The installer SHALL verify loop contract compatibility before external mutation

The installer SHALL run the same `loop:contract-coherence` check and SHALL report an
incompatible Pipeline/loop pairing. The verification SHALL run before the installer
performs any external mutation, and an incompatible pairing SHALL be surfaced as a
failure with remediation naming both versions rather than silently completing. The
installer SHALL NOT modify, overwrite, or migrate the goal-loop install or its runs.

#### Scenario: Incompatible pairing is reported at install time

- **WHEN** the installer runs against an environment whose installed goal-loop contract
  schema id is outside Pipeline's supported set
- **THEN** it SHALL surface the `loop:contract-coherence` failure naming both the
  Pipeline and goal-loop versions/schema ids
- **AND** it SHALL NOT report the install as coherent

#### Scenario: Verification precedes external mutation

- **WHEN** the installer detects an incompatible Pipeline/loop pairing
- **THEN** the incompatibility SHALL be detected before any external mutation is
  performed
- **AND** the goal-loop install and its existing runs SHALL be left untouched

---

### Requirement: The `loop:contract-coherence` check SHALL be unit-testable via injectable deps

The check implementation SHALL take the goal-loop discovery root and the file-reading
primitive as injected dependencies rather than resolving them from module-level
filesystem state, so unit tests can supply a fake install root, fake manifest contents,
and fake schema ids with no real filesystem, network, or subprocess access. The same
check function SHALL be used by `pipeline doctor`, by the installer, and by the
`pipeline:loop` run-start preflight, so the three surfaces cannot diverge.

#### Scenario: Fake manifest yields a deterministic outcome

- **WHEN** a unit test invokes the check with an injected discovery root and a reader
  returning controlled manifest and schema content
- **THEN** the result SHALL be determined solely by the injected inputs
- **AND** no real filesystem, network, or subprocess access SHALL occur

#### Scenario: One implementation backs all three surfaces

- **WHEN** the `loop:contract-coherence` outcome is computed for `pipeline doctor`, for
  the installer, and for the `pipeline:loop` run-start preflight with identical inputs
- **THEN** all three SHALL produce the same status and the same remediation text

