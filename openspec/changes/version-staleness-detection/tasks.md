## 1. Extend DoctorDeps interface

- [x] 1.1 Add `readTextFile(p: string): Promise<string | null>` to the `DoctorDeps` interface in `core/scripts/stages/doctor.ts`
- [x] 1.2 Implement `readTextFile` in `realDoctorDeps`: use `fs.promises.readFile(p, "utf8")`, catch all errors and return `null`
- [x] 1.3 Update any existing test fakes that implement `DoctorDeps` to add a stub `readTextFile` (e.g., returning `null` by default)

## 2. Add version argument to buildPreflightChecks

- [x] 2.1 Change `buildPreflightChecks(config: PipelineConfig)` signature to `buildPreflightChecks(config: PipelineConfig, version: string)` in `doctor.ts`
- [x] 2.2 Update the call site in `pipeline.ts` to pass the `VERSION` constant: `buildPreflightChecks(config, VERSION)`
- [x] 2.3 Update existing tests that call `buildPreflightChecks` directly to pass a version string argument

## 3. Implement the install:version-coherence check

- [x] 3.1 Derive `installRoot` inside `buildPreflightChecks` using `path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))` — this gives `core/` from `doctor.ts`'s location
- [x] 3.2 Add the `install:version-coherence` preflight check at check position 6 (after harness checks, before conditional checks) — the check closure captures `version` (from param) and `installRoot`
- [x] 3.3 Check logic: call `deps.readTextFile(join(installRoot, "package.json"))`; if null → fail with reinstall remediation; parse JSON; if `pkg.version` !== `version` → fail naming both; else → pass with detail string containing version and install path

## 4. Unit tests

- [x] 4.1 Test: versions match → `install:version-coherence` passes and detail contains version string and install path
- [x] 4.2 Test: versions differ → `install:version-coherence` fails and detail names both the loaded and on-disk versions and the install path
- [x] 4.3 Test: `readTextFile` returns `null` (unreadable package.json) → `install:version-coherence` fails with reinstall remediation
- [x] 4.4 Test: `readTextFile` returns malformed JSON → `install:version-coherence` fails with reinstall remediation
- [x] 4.5 Prove the tests bite: verify each new test fails without the implementation it covers

## 5. Mirror regeneration and CI

- [x] 5.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/`
- [x] 5.2 Run `npm run ci` from the repo root; treat any failure as not-done
