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

## 5. Launcher corrupt-install fallback (review-2 hardening)

- [x] 5.1 In `hosts/_shared/entry.template.mjs` and `scripts/pipeline-launcher.mjs`, factor the corrupt-install (`!pkgReadable`) doctor fallback into a `reportCorruptInstall(rawArgs, coreDir)` helper that honors `doctor --json` (stable JSON envelope), `doctor --is-ok` (zero output), and plain `doctor` (prose)
- [x] 5.2 In `scripts/pipeline-launcher.mjs`, move the `!pkgReadable` guard ahead of BOTH the `path` discovery fast-path and the `core/node_modules` check (only `--version` keeps its own corrupt-install handling), so `path --json` and a deps-less corrupt install both report version-coherence instead of a raw `ERR_INVALID_PACKAGE_CONFIG` / generic deps error
- [x] 5.3 Tests (`scripts/launcher-smoke.mjs`): malformed package.json with `doctor --json` (valid envelope), `doctor --is-ok` (silent, non-zero), `path --json` (coherent diagnostic, no raw Node error), malformed + no `node_modules` (version-coherence, not deps error), and the host shim's `--json`/`--is-ok` paths
- [x] 5.4 Prove the tests bite: each new smoke test fails without the launcher fix

## 6. Mirror regeneration and CI

- [x] 6.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/`
- [x] 6.2 Run `npm run ci` from the repo root; treat any failure as not-done
