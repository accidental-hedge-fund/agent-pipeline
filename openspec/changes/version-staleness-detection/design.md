## Context

The bug manifested as: `pipeline --version` reporting `1.1.1` while `core/package.json` on the "same install" showed `1.2.0`. The installer is already atomic (staging dir + `renameSync`), and the shim's `--version` short-circuit already reads from `core/package.json`. The actual divergence was between the INSTALLED skill (1.1.1 at `~/.claude/skills/pipeline/`) and the DEV REPO checkout (1.2.0 at `~/dev/agent-pipeline/`) — two separate trees, not one corrupted install. Without an explicit version-coherence check, this divergence is completely silent and indistinguishable from a legitimate single-install version.

## Goals / Non-Goals

**Goals**
- A runtime assertion (in `pipeline doctor`) that the `VERSION` constant the running `pipeline.ts` loaded from `core/package.json` still matches what is currently in that file — catching any future divergence (manual edits, corrupt installs, future version-surface regressions).
- The check output always includes the install path + version string so users can identify which install is active even on a passing run.
- Formal specification that the shim reads version from `core/package.json` at runtime (not a static string).

**Non-Goals**
- Network-based "is your install up-to-date?" check (requires connectivity, out of scope).
- Spawning a subprocess to re-test the shim's `--version` path from within doctor (fragile, adds I/O, and the simpler file-read approach catches the same failure modes).
- Changes to the installer, the state machine, or any pipeline stage.

## Decisions

**Decision: compare `VERSION` constant to `core/package.json` read at doctor runtime.**
The `VERSION` constant is loaded once via `createRequire(import.meta.url)("../package.json")` when `pipeline.ts` is first imported. Reading `core/package.json` again at doctor runtime catches: file modified after startup (unlikely but detectable), future regression where `VERSION` is hardcoded rather than dynamically loaded, or a corrupt install where `core/package.json` was changed but scripts were not updated. This is not a tautological check even though both currently read the same file — it is a runtime invariant assertion that the design should maintain.

**Decision: derive `installRoot` from `import.meta.url` in `doctor.ts`.**
`const installRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))` gives `core/` from wherever `doctor.ts` is loaded (dev tree, installed skill, npm global). This is the same derivation that `pipeline.ts` uses for `createRequire(import.meta.url)("../package.json")`, so both paths are guaranteed to resolve the same directory. The `installRoot` is passed into the check closure so unit tests can supply a fake path.

**Decision: pass `VERSION` as a second argument to `buildPreflightChecks`.**
The current signature `buildPreflightChecks(config: PipelineConfig)` ties the function to `VERSION` being an import-time side effect. Changing to `buildPreflightChecks(config: PipelineConfig, version: string)` makes the dependency explicit, allows unit tests to supply any version string, and removes an implicit import from `pipeline.ts` into `doctor.ts`. The call site in `pipeline.ts` passes the existing `VERSION` constant.

**Decision: add `readTextFile(p: string): Promise<string | null>` to `DoctorDeps`.**
This is the minimal injectable primitive needed — `null` on any error, raw text otherwise. The coherence check then does `JSON.parse` itself. An alternative (`readJson`) would couple the interface to JSON parsing; a raw text primitive is more general and parallels the existing interface style (`fsExists` returns bool, not the stat result). Adding to the interface requires updating all existing `DoctorDeps` fakes in tests; there are a small number of them.

**Decision: check position after harness checks, labeled `install:version-coherence`.**
Harness availability must be confirmed before investing in version-coherence details. The check ID follows the existing `install:*` namespace that could be introduced here to group install-level checks (currently no such namespace exists; this is the first check in that group).

## Risks / Trade-offs

- *Adding `readTextFile` to `DoctorDeps` is an interface change*: any test that constructs a `DoctorDeps` literal must add the new method. Low risk — the test count is small and the change is mechanical.
- *`buildPreflightChecks` signature change*: callers must pass `VERSION`. There is exactly one real call site (`pipeline.ts`). Tests that call `buildPreflightChecks` directly must add the argument. Low risk.
- *Check is a near-no-op under normal conditions*: both sources read the same file, so the check always passes in normal use. This is intentional — the value is catching future regressions and providing diagnostic output, not blocking any current path.
