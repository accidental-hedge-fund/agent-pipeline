## Why

`pipeline --version` and `core/package.json` were observed to report different versions on the same install during the #173–#176 pipeline-desk batch, causing a phantom P0 (#176 `--init` overwrite) that had already been fixed in v1.2.0 but reproduced on a stale install. The root cause is that there is no runtime assertion of the single-source-of-truth invariant: the version the launcher reports must be identical to the version in `core/package.json` the running scripts actually loaded from. Without this assertion, version drift is silent — a stale install blames the wrong codebase version, wastes investigation time, and erodes confidence in bug reports.

## What Changes

- **New `install:version-coherence` doctor check**: at runtime, read `core/package.json` from the install root (derived from `import.meta.url`) and compare its `version` field to the `VERSION` constant `pipeline.ts` loaded at startup. Pass if they match (always reporting the install path + version in the detail so users can see which install is active); fail with both versions named if they disagree.
- **`DoctorDeps` gains `readTextFile`**: a new injectable primitive (`readTextFile(p: string): Promise<string | null>`) so the coherence check is unit-testable with no real filesystem I/O.
- **`buildPreflightChecks` receives `version: string`**: the function's signature gains an explicit `version` argument (the `VERSION` constant) so it is independently testable without importing from `pipeline.ts`.
- **Explicit shim requirement in `cli-version-flag`**: the launcher shim SHALL read the version from `core/package.json` at the install root at runtime, and SHALL NOT embed a static version string — making the invariant formally specified.

## Capabilities

### New Capabilities
- `install-version-coherence`: runtime doctor check that verifies the `VERSION` constant loaded by `pipeline.ts` matches the `version` field in `core/package.json` at the install root, and reports the install path and version on every run (pass or fail).

### Modified Capabilities
- `doctor-preflight`: gains the `install:version-coherence` check in its required check set, plus the `readTextFile` extension to `DoctorDeps` and the `version` parameter on `buildPreflightChecks`.
- `cli-version-flag`: gains an explicit requirement that the launcher shim sources its version from `core/package.json` at runtime rather than from a static embedded string.

## Impact

- `core/scripts/stages/doctor.ts`: new check definition, `DoctorDeps` extension, `buildPreflightChecks` signature change.
- `core/scripts/pipeline.ts`: pass `VERSION` to `buildPreflightChecks`.
- `core/test/doctor.test.ts`: new test cases; update any existing `DoctorDeps` fakes to add `readTextFile`.
- No changes to the state-machine edges, any pipeline stage, or the installer.

## Acceptance Criteria

- [ ] `pipeline doctor` includes an `install:version-coherence` check whose passing output contains the install path and version string (e.g., `v1.2.1 at ~/.claude/skills/pipeline/core`)
- [ ] The check fails when `VERSION` (loaded at startup) and the current `core/package.json` version disagree; the failure detail names both versions and the install path
- [ ] The check fails with a clear remediation message when `core/package.json` cannot be read (missing or malformed)
- [ ] `buildPreflightChecks` signature is `(config: PipelineConfig, version: string)` and the caller (`pipeline.ts`) passes the `VERSION` constant
- [ ] `DoctorDeps` includes `readTextFile(p: string): Promise<string | null>` and the real implementation uses `fs.promises.readFile`
- [ ] Unit tests cover: version match → pass (install path in detail); version mismatch → fail (both versions in detail); unreadable `package.json` → fail with remediation
- [ ] `cli-version-flag` spec has a requirement that the shim reads version from `core/package.json` at runtime, not from an embedded string, with a scenario verifying the shim's version output matches the file
- [ ] `npm run ci` passes with no regressions
