## 1. Config schema — add `doctor` block

- [ ] 1.1 Add optional `doctor` sub-schema (`runOnStart`, `failFast` booleans, both defaulting `false`) to `PartialConfigSchema` in `config.ts`.
- [ ] 1.2 Update `DEFAULT_CONFIG` to include `doctor: { runOnStart: false, failFast: false }`.
- [ ] 1.3 Add a unit test: valid `doctor` block accepted; unknown key rejected; absent block → defaults.

## 2. Core doctor module (`stages/doctor.ts`)

- [ ] 2.1 Define `DoctorDeps` interface: thin I/O primitives (`execCheck(cmd): Promise<boolean>`, `fsExists(path): Promise<boolean>`, `fileMtime(path): Promise<number>`, `readConfig(): ResolvedConfig`).
- [ ] 2.2 Define `PreflightCheck` record type (`id: string`, `description: string`, `run: (deps: DoctorDeps) => Promise<CheckResult>`).
- [ ] 2.3 Implement each check as a `PreflightCheck` (required CLIs, GitHub auth, repo access, worktree cleanliness, harness availability, package install state, optional OpenSpec CLI, optional eval command).
- [ ] 2.4 Implement `runPreflight(deps: DoctorDeps, config: ResolvedConfig): Promise<PreflightResult>` — collects per-check results, respects `failFast`.
- [ ] 2.5 Implement `formatDoctorSummary(result: PreflightResult): string` — human-readable per-check output with remediation text on failures.
- [ ] 2.6 Implement `storePrefligtResult(result: PreflightResult): Promise<void>` — writes `.claude/pipeline-doctor-result.json` with a timestamp.
- [ ] 2.7 Implement `loadLatestPreflightResult(): Promise<PreflightResult | null>` — reads the stored result; returns `null` if absent.

## 3. `pipeline doctor` CLI command

- [ ] 3.1 Register `doctor` subcommand in `pipeline.ts`.
- [ ] 3.2 Wire `runPreflight` with real deps, print `formatDoctorSummary`, store result, exit 0/1.
- [ ] 3.3 Accept `--fail-fast` flag that overrides `config.doctor.failFast`.

## 4. Run-start preflight integration

- [ ] 4.1 In the main run loop entry point, when `config.doctor.runOnStart === true` or `--doctor` flag is passed, call `runPreflight` before entering the planning stage.
- [ ] 4.2 On any check failure, print the doctor summary and exit non-zero without entering planning.
- [ ] 4.3 Add `--doctor` flag to the CLI.

## 5. `--status` surface

- [ ] 5.1 In `--status` output, call `loadLatestPreflightResult()`; if present, append a preflight section with per-check summary and timestamp.
- [ ] 5.2 If no stored result, omit the preflight section silently.

## 6. Tests (`core/test/doctor.test.ts`)

- [ ] 6.1 Each individual check: pass case (fake deps → success) and fail case (fake deps → failure with remediation text present).
- [ ] 6.2 `runPreflight` with all checks passing → all-passing result.
- [ ] 6.3 `runPreflight` with one check failing and `failFast: false` → all other checks still run; result has the one failure.
- [ ] 6.4 `runPreflight` with one check failing and `failFast: true` → stops after first failure.
- [ ] 6.5 `runPreflight` skips OpenSpec check when `openspec.enabled` is false.
- [ ] 6.6 `runPreflight` skips eval-command check when `evalCommand` is not configured.
- [ ] 6.7 Run-start integration: failing preflight stops before planning (no planning call made with fake planning dep).
- [ ] 6.8 Run-start integration: passing preflight proceeds to planning (planning dep called once).
- [ ] 6.9 Run-start disabled: planning dep called without running checks when `runOnStart: false` and no `--doctor` flag.
- [ ] 6.10 `--status` includes preflight section when a stored result exists; omits it when none exists.

## 7. Mirror + CI

- [ ] 7.1 `node scripts/build.mjs` regenerates `plugin/` mirror.
- [ ] 7.2 `npm run ci` passes (ci:core, mirror check, install smoke).
