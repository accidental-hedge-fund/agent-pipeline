## 1. Define `CommandEntry` type and `COMMAND_REGISTRY`

- [x] 1.1 Create `core/scripts/command-registry.ts` with `CommandEntry` interface: `needsIssueNumber: boolean`, `allowedFlags: Set<string> | "all"`, `needsConfig: boolean`, `needsGhAuth: boolean`, `mutatesGitHub: boolean`, `supportsJson: boolean`.
- [x] 1.2 Define the `COMMAND_REGISTRY` constant: one entry per recognized command keyword — advance (the default/numeric case), init, doctor, release, intake, triage, merge, sweep, refine-spec, logs, summary, path, config, run, improve, scoreboard, cleanup, remove-worktree.
- [x] 1.3 For the `merge` entry, copy the existing `MERGE_ALLOWED_OPTS` values (`repoPath`, `base`, `profile`) into its `allowedFlags` set; the advance entry uses `allowedFlags: "all"`.
- [x] 1.4 Export `lookupCommand(keyword: string | undefined): CommandEntry | null` returning `null` for unrecognized keywords.
- [x] 1.5 Export `validateFlags(entry: CommandEntry, cmd: Command): string[]` returning the list of attribute names of explicitly-provided flags not in `entry.allowedFlags` (empty list when `allowedFlags === "all"`); uses `cmd.getOptionValueSource(key) === "cli"` to identify explicitly-provided flags.

## 2. Unit tests (`core/test/command-registry.test.ts`)

- [x] 2.1 Coverage guard: every recognized command keyword in the pipeline dispatch block has an entry in `COMMAND_REGISTRY`; any keyword missing from the registry fails the test.
- [x] 2.2 `lookupCommand("merge")` returns an entry with `mutatesGitHub: true` and an `allowedFlags` set that does NOT include `jsonEvents`, `detach`, `json`, or `isOk`.
- [x] 2.3 `lookupCommand(undefined)` and `lookupCommand("123")` return the advance entry with `allowedFlags: "all"`.
- [x] 2.4 `lookupCommand("unknown-cmd")` returns `null`.
- [x] 2.5 `validateFlags` returns the offending attribute name when a flag outside the allowlist is explicitly provided (simulated via a fake cmd with `getOptionValueSource` returning `"cli"` for the offending flag).
- [x] 2.6 `validateFlags` returns an empty list for the advance entry (allowedFlags: "all").
- [x] 2.7 Cross-check: every attribute name in every `allowedFlags` set exists in `buildCmd().options.map(o => o.attributeName())`; any stale entry fails the test.
- [x] 2.8 `needsIssueNumber` is true only for advance; false for all named sub-commands (including merge, which takes a PR number via a separate positional, not the issue number slot).

## 3. Wire registry into `pipeline.ts` dispatch

- [x] 3.1 Replace the `isInit`, `isDoctorCommand`, `isReleaseCommand`, `isIntakeCommand`, `isSweepCommand`, `isTriageCommand`, `isMergeCommand`, `isRefineSpecCommand` booleans with a single `const entry = lookupCommand(numArg)` call at the top of `main()`.
- [x] 3.2 Replace each per-command ad-hoc conflict/denylist block (`intakeConflicts`, `rwConflicts`, the `isDoctorCommand && opts.cleanup` guard, the `isReleaseCommand && isInit` guard, etc.) with a single `validateFlags(entry, cmd)` call followed by a unified error formatter that names the offending flags.
- [x] 3.3 Preserve the `merge` sub-command's existing error message format (including the phrase "does not support") so that any downstream tooling or tests asserting that message still pass.
- [x] 3.4 Ensure all existing `process.exit(2)` error paths for flag conflicts are covered by the unified validation or have an explicit per-command override where the message content is tightly specified (e.g., `--force` without `--remove-worktree`, `--is-ok` without doctor).

## 4. Extract lifecycle into `pipeline-run.ts`

- [x] 4.1 Create `core/scripts/pipeline-run.ts` and move the body of `runAdvance` into it as `export async function runAdvance(cfg: PipelineConfig, issueNumber: number, opts: CliOpts, deps: AdvanceDeps = {}): Promise<void>`.
- [x] 4.2 Export `AdvanceDeps` from `pipeline-run.ts`; keep a re-export from `pipeline.ts` to avoid breaking any existing import paths.
- [x] 4.3 Update `pipeline.ts` to import `runAdvance` from `./pipeline-run.ts`; ensure the local `runAdvance` definition is removed.
- [x] 4.4 Confirm that importing `{ runAdvance, AdvanceDeps }` from `pipeline-run.ts` does NOT pull in Commander, `process.argv`, or `process.exit` side-effects (verify by checking that `pipeline-run.ts` has no top-level imports from `commander`).

## 5. Golden CLI parsing tests (`core/test/pipeline-cli.test.ts`)

- [x] 5.1 For each registered command, test at least one valid invocation by calling `buildCmd().parse(synthetic_argv)` and asserting the parsed opts match expected values.
- [x] 5.2 For each registered command with an explicit `allowedFlags` set, test at least one invocation with an unsupported global flag and assert `validateFlags` returns a non-empty list (regression guard for the denylist gap).
- [x] 5.3 Regression: `pipeline merge 42 --detach` → `validateFlags` returns `["detach"]` (#217).
- [x] 5.4 Regression: `pipeline intake --description "foo" --status` → `validateFlags` returns `["status"]`.
- [x] 5.5 Valid: `pipeline 123 --dry-run --once` → advance entry, `validateFlags` returns `[]`.
- [x] 5.6 Valid: `pipeline doctor --json` → doctor entry, `validateFlags` returns `[]`.
- [x] 5.7 Valid: `pipeline merge 42 --repo-path /tmp/repo` → merge entry, `validateFlags` returns `[]`.

## 6. Documentation

- [ ] 6.1 Update the `.argument(...)` help string in `buildCmd()` if needed to keep the listed keyword set consistent with `COMMAND_REGISTRY`.
- [ ] 6.2 Update `README.md` / `hosts/claude/SKILL.md` if any command dispatch or flag behavior is user-visible.

## 7. Mirror + CI

- [x] 7.1 `node scripts/build.mjs` — regenerate plugin mirror.
- [x] 7.2 `npm run ci` green end-to-end.
