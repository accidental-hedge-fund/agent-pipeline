## Why

`pipeline.ts` has grown to 2,700+ lines by accreting per-command dispatch logic, ad-hoc flag-conflict lists, and lifecycle orchestration into a single file. Adding each new sub-command today requires editing four disconnected sections: the `isXxxCommand` detection boolean, a per-command conflict list (denylist-based, so new global flags silently pass through), the dispatch block, and `runAdvance`'s inner loop. The `merge` sub-command proved in #217 that an explicit allowlist-based approach is safer, but the pattern never generalized — twelve other commands still use ad-hoc denylist guards. Introducing a command registry makes the flag-scoping guarantee structural and uniform, and extracting the advance lifecycle into a `PipelineRun` service makes the run loop independently testable without importing the full CLI.

## What Changes

- Add `core/scripts/command-registry.ts` defining a `CommandEntry` record with per-command metadata: `needsIssueNumber`, `allowedFlags` (a `Set<string>` of Commander attribute names, or the sentinel `"all"`), `needsConfig`, `needsGhAuth`, `mutatesGitHub`, `supportsJson`.
- Register every current command in the registry: advance (the default/numeric case), init, doctor, release, intake, triage, merge, sweep, refine-spec, logs, summary, path, config, run, improve, scoreboard, cleanup, remove-worktree.
- Replace the cascade of `isXxxCommand` booleans and per-command conflict/denylist blocks in `pipeline.ts` with a single registry lookup that (a) determines whether an issue number is required, (b) validates that every explicitly-provided global flag appears in the command's allowlist before any mutating operation, and (c) rejects unrecognized keywords.
- Extract `runAdvance` into `core/scripts/pipeline-run.ts`; the CLI calls it via the registry dispatch. Same signature and behavior.
- Add golden CLI parsing tests: for each registered command, assert valid invocations dispatch correctly and every unsupported flag is rejected with exit code 2 before any mutation.

## Capabilities

### New Capabilities
- `command-registry`: The declarative per-command metadata table, its lookup semantics, and the allowlist-based flag enforcement derived from it.
- `pipeline-run-service`: The extracted advance-loop lifecycle service interface and its injectable `AdvanceDeps` contract.

### Modified Capabilities
(none — existing sub-command specs describe observable behavior that does not change; only the enforcement mechanism moves from ad-hoc to registry-driven)

## Impact

- `core/scripts/command-registry.ts` — new file (registry + lookup helpers).
- `core/scripts/pipeline-run.ts` — new file (extracted lifecycle from `runAdvance`).
- `core/scripts/pipeline.ts` — `main()` refactored to use registry; `runAdvance` extracted; `buildCmd()` argument string updated.
- `core/test/command-registry.test.ts` — unit tests for registry lookup and flag enforcement.
- `core/test/pipeline-cli.test.ts` — golden CLI parsing tests (one per command × allowed/unsupported flag pair).
- `plugin/` mirror — regenerated.

## Acceptance Criteria

- [ ] A `COMMAND_REGISTRY` constant exists in `core/scripts/command-registry.ts` with an entry for every recognized command keyword; `lookupCommand("unknown")` returns `null`.
- [ ] Every registered command with an explicit `allowedFlags` set rejects any explicitly-provided flag outside that set with exit code 2, before config resolution or any GitHub mutation — for all commands, not just `merge`.
- [ ] Adding a new global flag to `buildCmd()` without declaring it in a command's `allowedFlags` causes that flag to be rejected when provided to that command; no code change to per-command validation is required.
- [ ] `runAdvance` and `AdvanceDeps` are importable from `core/scripts/pipeline-run.ts` without importing Commander or any CLI initialization side-effect.
- [ ] Existing tests that inject fake `AdvanceDeps.now` still pass without modification after the extraction.
- [ ] A cross-check test in `command-registry.test.ts` fails if an `allowedFlags` set names an attribute that no longer exists in `buildCmd()`.
- [ ] Golden CLI parsing tests cover every registered command: at least one valid invocation and one invocation with an unsupported flag (asserted exit-2).
- [ ] `npm run ci` passes end-to-end after the change.
