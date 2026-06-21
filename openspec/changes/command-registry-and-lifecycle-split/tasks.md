## 1. Define the CommandMeta type and COMMAND_REGISTRY table

- [x] 1.1 Create `core/scripts/command-registry.ts`: export `CommandMeta` interface (`allowedFlags: Set<keyof CliOpts>`, `mutatesGitHub`, `needsConfig`, `needsIssue`, `supportsJson`, `requiresArgs`) and `COMMAND_REGISTRY: Record<string, CommandMeta>` with an entry for every recognized subcommand (`init`, `doctor`, `logs`, `path`, `config`, `run`, `release`, `intake`, `roadmap`, `sweep`, `triage`, `merge`, `summary`, and the default advance path).
- [x] 1.2 Derive each entry's `allowedFlags` set from the existing hand-written guards in `pipeline.ts` — the merge entry is the template; replicate the same care for every command.

## 2. Replace per-command flag-guard blocks in main() with generic registry lookup

- [x] 2.1 In `pipeline.ts` `main()`, after `cmd.parse()`, resolve the subcommand from `cmd.args[0]`, look it up in `COMMAND_REGISTRY`, and run the generic `cmd.getOptionValueSource(key) === "cli"` allowlist guard for all explicitly-provided options not in the entry's `allowedFlags`.
- [x] 2.2 Remove the hand-written per-command guard blocks for `merge`, `triage`, `intake`, `release`, `doctor`, and `init`; confirm behavior is identical.
- [x] 2.3 Replace the hard-coded `recognized` array (line 730) with `Object.keys(COMMAND_REGISTRY)` so the unrecognized-subcommand error stays in sync automatically.

## 3. Extract runAdvance into pipeline-run.ts

- [x] 3.1 Create `core/scripts/pipeline-run.ts`; move `runAdvance` (and its helpers `isAutoLoopRecoverable`, `isAutoLoopEligible`, `canAutoLoopContinue`, `MAX_ITERATIONS`, and `AdvanceDeps`) verbatim — no logic changes.
- [x] 3.2 In `pipeline.ts`, replace the inlined `runAdvance` definition with an import from `pipeline-run.ts`; keep the call site in `main()` identical.
- [x] 3.3 Assert in a unit test that `pipeline-run.ts` contains no `import … from.*commander` and no `import … from.*pipeline` statements (import-direction guard).

## 4. Golden CLI parsing tests

- [x] 4.1 Add `core/test/cli-registry.test.ts`: table-driven tests using spawnSync to run the CLI; one row per known command × disallowed-flag pairing currently guarded in `main()` — assert exit code 2 and "does not support" error for each.
- [x] 4.2 Add registry-coverage test: assert every key of a representative `CliOpts` object appears in at least one `COMMAND_REGISTRY` entry's `allowedFlags`.

## 5. Migrate existing runAdvance tests to the new module boundary

- [x] 5.1 Update any existing test that imports `runAdvance`, `isAutoLoopRecoverable`, `isAutoLoopEligible`, or `canAutoLoopContinue` from `pipeline.ts` to import from `pipeline-run.ts`.
- [x] 5.2 Confirm all existing stage-loop and auto-loop unit tests pass without modification to test logic.

## 6. Mirror regeneration and CI gate

- [x] 6.1 Run `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror alongside all source changes.
- [x] 6.2 Run `npm run ci` from the repo root; confirm `ci:core`, mirror check, and install-smoke all pass green.
