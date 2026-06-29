# Logging Surface Consolidation

- [x] Inspect the post-#334 logging implementation and documentation.
- [x] Identify open backlog issues that could compound logging fragmentation.
- [x] Remove tracked runtime run artifacts from `.agent-pipeline/runs/` without deleting local ignored output.
- [x] Consolidate host/operator docs away from `/tmp` log redirection and toward the run store / `pipeline logs`.
- [x] Replace the dedicated transitions-log surface with run-store event visibility, or remove it if redundant.
- [x] Update tests/docs and regenerate the generated plugin mirror.
- [x] Run focused tests, mirror check, and full `npm run ci`.
- [x] Commit changes and open a PR against `main`.

## Review Results

- Focused logging/CLI tests passed: `node --test --experimental-strip-types test/run-logs.test.ts test/pipeline-cli.test.ts test/pipeline-override.test.ts`.
- Mirror check passed: `node scripts/build.mjs --check`.
- OpenSpec validation passed: `openspec validate --all`.
- Whitespace check passed: `git diff --check`.
- Full CI passed: `npm run ci`.

# Config Sync Implementation Plan

## Checklist

- [x] Update `.github/pipeline.yml` with active model aliases.
- [x] Create OpenSpec change artifacts for `config-sync-command`.
- [x] Implement the `pipeline config sync` command.
- [x] Refresh this repo's `.github/pipeline.yml` scaffold drift while preserving active overrides.
- [x] Add tests and documentation.
- [x] Regenerate generated plugin mirror.
- [x] Verify OpenSpec, targeted tests, and full CI.
- [x] Review the final diff.

## Review Results

- Initial config validation passed with expected warnings for model aliases on
  Codex-owned implementer phases.
- OpenSpec change `config-sync-command` was created and validated before
  implementation.
- Focused config/init tests pass with sync coverage: 96 tests.
- `.github/pipeline.yml` was refreshed via `pipeline config sync --apply`; a
  follow-up preview reports it is already current.
- Final verification passed: OpenSpec validation, config validation, sync no-op,
  `git diff --check`, focused config/init tests, and full `npm run ci`.

# Pipeline Throughput Remediation

- [x] Create OpenSpec change artifacts for throughput/stage observability remediation.
- [x] Fix stage lifecycle labels and accounting for planning, plan-review, and implementing.
- [x] Add early OpenSpec stale-delta guard to fix rounds.
- [x] Add prompt-size telemetry to stage accounting and scoreboard reporting.
- [x] Add safe queue batch locking.
- [x] Update docs and generated plugin mirror.
- [x] Run targeted tests and full npm run ci.
- [x] Record verification results.

## Verification

- [x] `openspec validate pipeline-throughput-remediation`
- [x] `node --test --experimental-strip-types test/planning.test.ts test/planning-crash-recovery.test.ts test/planning-resume.test.ts`
- [x] `node --test --experimental-strip-types test/fix.test.ts test/pre-merge-spec-consistency.test.ts`
- [x] `node --test --experimental-strip-types test/run-store.test.ts test/harness.test.ts test/scoreboard.test.ts`
- [x] `node --test --experimental-strip-types test/queue.test.ts`
- [x] `npm test` from `core/`
- [x] `node scripts/build.mjs`
- [x] `npm run ci`
