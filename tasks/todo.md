# README state-machine diagram

# Grok Build Configuration Hardening

## Plan

- [x] Add the stable `--no-auto-update` flag to Agent Pipeline's Grok adapter and cover its invocation shape.
- [x] Add dotfiles-managed Grok configuration and a native global rule that reuses the shared operating contract without duplicating Claude-specific instructions.
- [x] Add deterministic dotfiles verification for the effective Grok rule source.
- [x] Verify focused tests, the generated plugin mirror, the dotfiles configuration render, and repository diffs.

## Scope

- This change makes the existing Grok adapter more stable for headless pipeline runs and makes workstation Grok setup reproducible.
- It deliberately does not introduce a first-class `grok` Agent Pipeline host profile; that needs separate routing and packaging design.

## Review

- Agent Pipeline: `node --test --experimental-strip-types test/harness.test.ts`, `node scripts/build.mjs`, and full `npm run ci` passed. The generated `plugin/` mirror includes the adapter change.
- Dotfiles: `bash -n scripts/verify.sh`, a targeted chezmoi dry-run, and `scripts/verify.sh --agent` passed. The two Grok files were applied to this workstation; `grok inspect --json` reports the native global contract and marks the discovered Claude global file `disabled`.


## Plan

- [x] Inspect the README structure and decide where the diagram-equivalent belongs.
- [x] Translate the supplied image into README-native content that renders well on GitHub.
- [x] Update `README.md` with the visual flow, off-ramp, gates, and principles.
- [x] Verify Markdown rendering/anchors and run the smallest meaningful docs check.
- [x] Record results and changed files.

## Notes

- Scope is docs-only. No edits under `core/`, so the generated `plugin/` mirror does not apply.
- The README should preserve the existing core message: bounded, cross-harness, human-gated, never auto-merging.

## Review

- Added `README.md` lifecycle section with Mermaid flow, stage-band table, and naive-loop comparison.
- Preserved current implementation vocabulary: `pre-merge -> eval-gate -> shipcheck-gate -> ready-to-deploy`, with visual/E2E checks described as `eval-gate`/`shipcheck-gate` use cases rather than a current `visual-gate` label.
- Verification passed: `git diff --check`, README lifecycle anchor check, and full `npm run ci`.

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

# PR-Number Blocker Event Routing

- [x] Inspect current unblock/override event routing and adjacent tests.
- [x] Fix `blocker_cleared` event lookup for PR-number invocations without changing GitHub mutation semantics.
- [x] Add regression coverage for PR-number run-store IDs.
- [x] Regenerate the `plugin/` mirror so `build.mjs --check` passes.
- [x] Run targeted tests, OpenSpec validation, mirror check, and full CI if feasible.
- [x] Record review notes and final verification results.

## Review Results

- Focused regression tests passed: `node --test --experimental-strip-types test/pipeline-override.test.ts`.
- Focused logging/CLI tests passed: `node --test --experimental-strip-types test/pipeline-override.test.ts test/run-logs.test.ts test/pipeline-cli.test.ts`.
- Mirror check passed: `node scripts/build.mjs --check`.
- OpenSpec validation passed: `npx openspec validate --all`.
- Whitespace check passed: `git diff --check`.
- Full CI passed: `npm run ci`.
