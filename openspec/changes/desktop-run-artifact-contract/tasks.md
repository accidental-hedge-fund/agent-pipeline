## 1. Run directory and run-id infrastructure

- [ ] 1.1 Define `RunId` type and `runIdFor(issue, startedAt)` helper (produces `<issue>-<YYYY-MM-DDTHH-MM-SSZ>`)
- [ ] 1.2 Create `core/scripts/run-store.ts` with injectable `RunStoreDeps` (`fs`, `now`) and exports: `initRunDir`, `appendEvent`, `finalizeRun`
- [ ] 1.3 Implement `initRunDir`: create `.agent-pipeline/runs/<run-id>/`, write `run.json` (schema_version, run_id, issue, repo, profile, started_at), create empty `events.jsonl`, append `run_start` event
- [ ] 1.4 Define `RunEvent` discriminated union type: `run_start`, `run_complete`, `stage_start`, `stage_complete` (with `outcome`), `pr_created`, `pr_updated`, `worktree_created`, `worktree_removed`, `review_verdict`, `blocker_set`, `blocker_cleared` — all carry `schema_version`, `type`, `at`
- [ ] 1.5 Implement `appendEvent(runDir, event, deps)`: O_APPEND write of `JSON.stringify(event) + "\n"`; non-fatal (catches and logs on I/O error per `run-artifact-conventions`)
- [ ] 1.6 Implement `readEvents(runDir, deps)`: read `events.jsonl`, split on `\n`, `JSON.parse` each non-empty part, skip unparseable lines, return array (empty if file absent)
- [ ] 1.7 Implement `finalizeRun(runDir, bundle, stateDir, issue, deps)`: append `run_complete` event, write `summary.json` (atomically), write legacy `<stateDir>/<issue>/evidence.json` (non-fatal)
- [ ] 1.8 Implement `terminal.log` capture: tee pipeline stdout/stderr through a write stream to `<runDir>/terminal.log` opened at `initRunDir`

## 2. Stage integration

- [ ] 2.1 Thread `runDir` through pipeline dispatch as part of the existing `deps`/context passed to stage handlers
- [ ] 2.2 Each stage handler calls `appendEvent(runDir, { type: "stage_start", ... })` on entry and `appendEvent(runDir, { type: "stage_complete", outcome, ... })` on exit
- [ ] 2.3 Add `pr_created` / `pr_updated` event appends in the planning stage where PRs are opened/updated
- [ ] 2.4 Add `worktree_created` / `worktree_removed` event appends in worktree lifecycle paths
- [ ] 2.5 Add `review_verdict` event append in the review stage after a verdict is parsed
- [ ] 2.6 Add `blocker_set` / `blocker_cleared` event appends in blocking/unblocking paths

## 3. CLI additions

- [ ] 3.1 Add `--json-events` flag to `pipeline.ts`: when set, `appendEvent` also writes the JSON line to `process.stdout`
- [ ] 3.2 Add `logs` subcommand to `pipeline.ts`: `pipeline logs [<run-id>] [--follow | -f]`
- [ ] 3.3 Implement `logs` with no argument: list `.agent-pipeline/runs/` sorted by mtime descending, print run-ids, exit 0 (or message if empty)
- [ ] 3.4 Implement `logs <run-id>` without `--follow`: print `terminal.log` contents and exit 0; exit non-zero with error message if run-id unknown
- [ ] 3.5 Implement `logs <run-id> --follow`: `spawn('tail', ['-f', terminalLogPath])` piped to stdout; exit non-zero if run-dir absent

## 4. Tests

- [ ] 4.1 `initRunDir` unit test: creates run dir, writes `run.json` with all required fields, `events.jsonl` exists, `run_start` event present
- [ ] 4.2 `appendEvent` unit test: idempotent append; injected `fs` fake verifies O_APPEND-style call; I/O error is non-fatal (no throw)
- [ ] 4.3 `readEvents` unit test: normal parse; partial last line skipped; missing file returns `[]`; unknown fields preserved
- [ ] 4.4 `finalizeRun` unit test: `run_complete` appended; `summary.json` written; legacy `evidence.json` written; legacy write failure is non-fatal
- [ ] 4.5 `--json-events` unit test: `appendEvent` writes to fake stdout as well as fake file when flag is active
- [ ] 4.6 `logs` subcommand integration test: no-arg lists runs; known run-id prints terminal.log; unknown run-id exits non-zero; `--follow` opens tail (subprocess stub)
- [ ] 4.7 Backward-compat regression test: reading legacy `<stateDir>/<issue>/evidence.json` after `finalizeRun` returns the same content as `summary.json`
- [ ] 4.8 Schema_version test: every event type emitted by `appendEvent` carries `schema_version: 1`

## 5. Mirror + CI

- [ ] 5.1 `node scripts/build.mjs` regenerates `plugin/`
- [ ] 5.2 `npm run ci` green (core tests, mirror check, install smoke)
