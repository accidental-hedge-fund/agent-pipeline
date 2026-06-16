## 1. Detached Launcher — Core Module

- [ ] 1.1 Create `core/scripts/detach.ts`: export `spawnDetached(issueNumber, args, opts: { timeout?: number, flockTimeoutMs?: number })` using `child_process.spawn({ detached: true })` + `proc.unref()` for process-group escape
- [ ] 1.2 Implement per-issue lock file path (`~/.pipeline/runs/<issue>/.lock`) and advisory flock acquisition with configurable timeout (default 5 000 ms); exit non-zero with clear message if lock not acquired
- [ ] 1.3 Implement run-directory creation (`~/.pipeline/runs/<issue>/<timestamp>/`) and log file wiring (`stdout`/`stderr` → append-mode file descriptors passed as `stdio` to the detached child)
- [ ] 1.4 Implement atomic sentinel write: on every exit path inside the detached child (normal exit, uncaught exception, SIGTERM handler) write `sentinel.tmp` then `fs.renameSync` to `sentinel.json` with `{ exitCode, durationMs, completedAt, timedOut? }`
- [ ] 1.5 Implement `--timeout <seconds>` watchdog: `setTimeout` inside the detached child that sends `SIGKILL` to its own process group and writes sentinel with `{ exitCode: -1, timedOut: true }` before exiting

## 2. Detached Launcher — CLI Integration

- [ ] 2.1 Add `--detach` flag to the `pipeline run <issue>` command in `core/scripts/pipeline.ts`; when set, delegate to `spawnDetached` and print the run directory path to stdout
- [ ] 2.2 Add `--timeout <seconds>` flag (no default; passed through to `spawnDetached`) and `--flock-timeout <ms>` flag (default 5 000)
- [ ] 2.3 Ensure non-`--detach` code path is unchanged (no regression to existing `pipeline run` behavior)

## 3. Host Install Discovery — Core Module

- [ ] 3.1 Create `core/scripts/discovery.ts`: export `discoverHosts(): Promise<DiscoveryResult>` where `DiscoveryResult = { corePath: string | null, version: string | null, hostCoverage: 'missing' | 'claude-only' | 'codex-only' | 'both', hosts: { claude: HostEntry, codex: HostEntry } }` and `HostEntry = { available: boolean, cliBin: string | null }`
- [ ] 3.2 Implement install-location probe sequence: npm global bin (`npm root -g`), `~/.claude/skills/pipeline/`, `~/.codex/skills/pipeline/`, `./node_modules/.bin/pipeline`; resolve `corePath` and `version` from the first hit
- [ ] 3.3 Probe `claude` and `codex` host CLIs via `which claude` / `which codex`; combine with `corePath` presence to derive `hostCoverage`
- [ ] 3.4 Surface probe errors (e.g., `npm root -g` failure) as a thrown error so the CLI layer can exit non-zero with a diagnostic

## 4. Host Install Discovery — CLI Integration

- [ ] 4.1 Add `pipeline path` subcommand to `core/scripts/pipeline.ts` that calls `discoverHosts()` and prints human-readable output (core path, version, host coverage summary)
- [ ] 4.2 Add `--json` flag to `pipeline path` that serializes `DiscoveryResult` as JSON to stdout; exit code 0 for any resolved state (including `missing`), non-zero on probe error
- [ ] 4.3 Verify `pipeline --version` behavior is unchanged (no regression)

## 5. Tests

- [ ] 5.1 Unit tests for `spawnDetached` in `core/test/detach.test.ts`: mock `child_process.spawn`, assert `detached: true`, `stdio` wiring, lock acquisition, and sentinel content for success / error / watchdog paths
- [ ] 5.2 Unit tests for `discoverHosts` in `core/test/discovery.test.ts`: mock `which` and install-path probes; assert correct `hostCoverage` for all four states (missing / claude-only / codex-only / both)
- [ ] 5.3 Regression test: `pipeline run <issue>` without `--detach` still calls the existing code path (not `spawnDetached`)
- [ ] 5.4 Regression test: `pipeline --version` exits 0 regardless of host availability (no change to `discoverHosts` from `--version` path)

## 6. Documentation

- [ ] 6.1 Add a "Desktop Integration" section to the repository README covering: `pipeline run <issue> --detach [--timeout <seconds>]` launch command, run-directory layout, how to poll `sentinel.json` for completion, and `pipeline path --json` with annotated output for all four `hostCoverage` values
- [ ] 6.2 Regenerate `plugin/` mirror: run `node scripts/build.mjs` and commit the updated mirror alongside all source changes

## 7. CI Gate

- [ ] 7.1 Run `npm run ci` from repo root and confirm all tests pass and the mirror is in sync before marking complete
