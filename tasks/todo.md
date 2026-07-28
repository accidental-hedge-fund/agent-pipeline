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

# Harness Evaluation — v1.28.1 Rerun

- [x] Verify v1.28.1 includes #607 evaluator isolation and #608 repository-configured harness roles.
- [ ] Run a two-cell release smoke: Codex and Grok as isolated primary implementers on the same frozen fixture.
- [ ] Carry the paired primary → reviewer evaluator forward onto v1.28.1.
- [ ] Run and grade the expanded paired corpus across valid primary/reviewer, model, and effort coordinates.
- [ ] Publish a decision-grade comparison with limitations and a recommended default.

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

# Harness and Model Evaluation Matrix

## Plan

- [x] Create an isolated evaluation worktree from `origin/main`.
- [x] Inventory the frozen Agent Pipeline fixtures, grading coverage, harness adapters, and comparative reporting contract.
- [x] Verify that the native evaluator cannot represent distinct primary and secondary harnesses in one treatment cell.
- [x] Snapshot `B0`, the current Claude-primary → Codex-reviewer configuration: resolved config, CLI versions, available model IDs, and historical run-store metrics (no comparable historical eval-run store exists in this checkout).
- [ ] Build and validate a balanced frozen corpus: two deterministic implementation fixtures now exist, but historical evidence is unavailable in this checkout and at least four further independent fixtures are required.
- [ ] Run native role-screening experiments: compare the current Claude primary against Codex and Grok primary candidates; compare the current Codex reviewer against Grok reviewer candidates. Vary only valid, explicitly recorded model/effort settings.
- [ ] Select Pareto-optimal primary and reviewer candidates; do not carry dominated model/effort settings into the paired trial.
- [x] Create an OpenSpec change for a paired evaluator whose cell runs implementation → review of the produced diff → fix → re-review, with separate primary/reviewer harness, model, and effort coordinates.
- [x] Implement, test, document, and regenerate the plugin mirror for that paired evaluator.
- [x] Run the paired matrix against `B0`: Claude→Codex, Codex→Grok, Grok→Codex, Codex→Codex, and Grok→Grok (one replicate × two fixtures; deliberately underpowered pilot).
- [x] Grade and report paired results; reject Codex-primary pairs and identify Grok→Codex as the provisional finalist, pending the expanded corpus and reviewer-safety screen.
- [ ] Validate the recommended pairing in a limited live pipeline pilot before any global harness migration.

# Repository-Configured Harness Roles

## Plan

- [ ] Create an OpenSpec change for repository-configured primary and secondary harness roles.
- [ ] Extend the strict `.github/pipeline.yml` schema with explicit primary/secondary harness selection, preserving profile values as defaults only.
- [ ] Route models and efforts through the selected built-in harnesses, including Grok primary and Codex secondary.
- [ ] Update generated plugin mirror, documentation, config validation, and regression tests.
- [ ] Verify with focused suites, config validation, mirror check, OpenSpec validation, and full CI.

## Decision Record

- Native `pipeline evals` treatments contain a single `harness` axis. Its `end-to-end` mode invokes that same treatment harness for every available fixture stage; it does not model a distinct implementer and reviewer.
- The existing fixtures include deterministically graded planning, fix/implementation, and review cases. They support role-quality comparison, but do not independently validate real two-harness review/fix interactions.
- Do not collapse an unpaired role score into a claim that a primary/reviewer pairing has been tested.
- 2026-07-27 correction: profile-owned implementer selection is not an acceptable production configuration model. `.github/pipeline.yml` must select both primary and secondary harnesses independently; profiles are host/UI defaults only.

## Execution Log

- 2026-07-27: Created the isolated `eval/harness-matrix-20260727` worktree at `6b2803d`; B0 is `.github/pipeline.yml` under profile `claude` (Claude Sonnet implementation/fix, Codex default review).
- 2026-07-27: Verified local harness readiness: Claude 2.1.216, Codex 0.145.0, Grok 0.2.112; Grok is authenticated and exposes `grok-4.5` only.
- 2026-07-27: Implemented explicit named primary/reviewer treatments and paired implementation → dynamic-diff review → optional fix → re-review execution. Focused suite: 111 passing tests; OpenSpec validation and plugin mirror check pass.
- 2026-07-27: First pilot was stopped after discovering `paired-worktree-await` was already fixed in the frozen base; its results are excluded. Replaced it with `paired-scoreboard-duplicate-cost`, which demonstrably fails at the frozen base because duplicate cost entries overwrite silently.
- 2026-07-27: Clean experiment `harness-pair-pilot-20260727b` planned 10 cells (5 ordered pairs × 2 deterministic implementation fixtures × 1 replicate), then completed all 10 cells with no infrastructure/auth/timeout failures.
- 2026-07-27: Grade/report artifacts were written: 10 completed runs and 10 deterministic grades. The redundant grade process also completed successfully.
- 2026-07-27: Started full repository verification with `npm run ci` after the paired-evaluator implementation, fixture, manifest, and documentation changes.
- 2026-07-27: `npm run ci` passed. The evidence-backed pilot readout is `docs/harness-pair-pilot-2026-07-27.md`; it recommends no routing change yet and names Grok 4.5 → Codex as the provisional finalist.
- 2026-07-27: Added `core/evals/campaigns/reviewer-screen-20260727.json` to directly measure Codex versus Grok reviewer precision/recall on the seeded-defect fixture (2 replicates each); planning/run/grade/report follows.
- 2026-07-27: Stopped the first reviewer screen at 2/4 malformed cells. Root cause: native review prompts omitted the production JSON verdict contract. Filed #606, added the contract plus regression test, and will rerun under experiment id `reviewer-screen-20260727b`.
- 2026-07-27: Corrected reviewer screen completed 4/4 cells and 4/4 grades. Codex recall was 0.0 in both runs; Grok had recall 0.0 then 0.5 and one malformed output. Neither reviewer has sufficient safety evidence for a production migration.
- 2026-07-27: Final verification after the review-prompt repair passed: focused evaluator tests, `node scripts/build.mjs`, strict OpenSpec validation, `git diff --check`, and full `npm run ci`.
- 2026-07-27: Began Codex capability discovery for the expanded matrix. The installed CLI supports explicit `-m <model>` and the evaluator passes effort as `-c model_reasoning_effort=<effort>`; neither CLI help nor the current evaluator discovers account-entitled model IDs, so the next gate is an official-docs lookup followed by controlled read-only preflight calls.
- 2026-07-27: Refreshed the official local Codex manual. It recommends `gpt-5.6` for demanding agents and `gpt-5.6-terra` for lighter/faster work; documented effort values include `low`, `medium`, `high`, and `ultra` when a model supports them. Account entitlement still requires a real invocation check.
- 2026-07-27: The first read-only entitlement probe terminated in its shell wrapper before results could be recorded (`zsh: read-only variable: status`); no candidate outcome was inferred from that failed wrapper. Retrying with a corrected wrapper.
- 2026-07-27: Controlled read-only probes found that this ChatGPT-authenticated Codex CLI rejects `gpt-5.6` (`400: not supported when using Codex with a ChatGPT account`) at both `low` and `high`; `gpt-5.6-terra` successfully completed at both `low` and `medium`. Continuing with established coding-model and default-coordinate probes.
- 2026-07-27: Additional successful probes: `gpt-5.4` at `medium` and `high`, `gpt-5.3-codex-spark` at `medium`, and `gpt-5.6-terra` at `high`. Corrected the prior pilot provenance: the unflagged Codex default was deterministically pinned by `~/.codex/config.toml` to `gpt-5.6-terra` with `high` effort, not an unknown CLI-chosen model.
- 2026-07-27: Completed capability discovery: `gpt-5.5` at `high` and `gpt-5.6-terra` at `ultra` also completed. The eligible Codex space is therefore explicit and account-tested; `gpt-5.6` is excluded for this account.
- 2026-07-27: Added three evidence-backed paired fixtures (release suffix classification, fenced plan-revision acknowledgement, and detached-run repository validation), bringing the implementation corpus to five tasks. Fixture validation passed; the release and plan-revision hidden checks demonstrably fail at the frozen base. The detached-run baseline probe initially lacked its normal `core/node_modules` dependency, so it is being rerun with that evaluator prerequisite before acceptance.
- 2026-07-27: Excluded two proposed corpus cases rather than counting them: detached-run validation requires dependencies the isolated evaluator does not provision, and stale-worktree removal was already fixed at the frozen base. Replaced them with linked-checkout managed-worktree discovery; its hidden check fails at the base because `resolveManagedRoots` does not exist. The frozen primary corpus is now five deterministic, graded tasks.
- 2026-07-27: Created `primary-model-screen-20260727`: six account-tested primary coordinates (Grok 4.5; Codex Terra low/high; Codex 5.4 high; Codex 5.5 high; Codex Spark medium) × five fixtures × one randomized replicate = 30 cells. It intentionally does not claim a secondary-harness decision; that follows only after this role screen eliminates dominated primary coordinates.
- 2026-07-27: First plan invocation used a `core/`-relative manifest path while the evaluator resolves from repository root, producing an `ENOENT` before any run was created. Retrying with the root-relative `core/evals/...` path.
- 2026-07-27: The corrected plan expanded to 30 cells and the serialized run began. First durable result: `codex-gpt-5.6-terra-low` completed the linked-worktree fixture in 30.09 s, changed no paths, and left both checks false. Grok 4.5 is executing the next cell under the fixed 900 s treatment deadline; no quality conclusion is drawn before grading.
- 2026-07-27: Invalidated and stopped `primary-model-screen-20260727` after 1/30 cells. Its Codex trajectory proves the nested Codex sandbox failed before repository access (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`), so its no-change/check-failure result is infrastructure evidence, not a model score. New experiment id `primary-model-screen-20260727b` will set the documented `PIPELINE_CODEX_NO_SANDBOX=1` escape hatch for the externally sandboxed evaluator and keep the invalid artifacts separate.
- 2026-07-27: Confirmed the sandbox escape hatch with an explicit `gpt-5.6-terra/low` read-only probe, then stopped `primary-model-screen-20260727b` before it recorded a cell. With repository access restored, Codex followed the copied root `AGENTS.md` pipeline workflow instead of the frozen task: it created a nested `.claude/worktrees/fix+linked-managed-worktree-discovery` worktree and invoked unrelated `pipeline` commands. The parent and nested generated worktrees were inspected and removed; the nested worktree contained only its own `tasks/todo.md` edit. This proves two evaluator defects: no enforced eval-specific instruction boundary and no command boundary that blocks nested pipeline/worktree execution. Neither experiment may contribute model-quality evidence.
- 2026-07-27: Filed #607 for enforced local-harness eval isolation (instruction replacement/restoration, command boundary, recorded denial, explicit Codex external-sandbox capability, and regression tests). Initial issue creation failed because the repository has no `backlog` label; retried with its existing `bug` label only: https://github.com/accidental-hedge-fund/agent-pipeline/issues/607.
- 2026-07-27: Created milestone `v1.28.1` (GitHub milestone #26; it did not previously exist), filed #608 for repository-configured primary/secondary harness roles, and assigned both #607 and #608 to `v1.28.1`.
- 2026-07-27: Audited the earlier paired-pilot trajectories after the evaluator failures. The manifest did explicitly select each primary/reviewer harness (the Codex host session did not choose treatments), but all four Codex-primary implementation trajectories contain the same pre-command Bubblewrap failure. Therefore Codex-primary failures and the former Grok→Codex provisional-finalist recommendation are invalidated; only narrow Grok/Claude implementation evidence remains, pending #607 and rerun.
