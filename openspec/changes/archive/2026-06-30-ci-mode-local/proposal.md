## Why

The pipeline runs the repo's full CI command (`npm run ci`) locally in the test gate after every implement/fix step, then pushes and waits for GitHub Actions to run the *same* command again in the pre-merge gate. For repos where Actions is identical to the local gate, the second run is pure redundant cost — GitHub Actions minutes spent re-proving something already proven locally in the same run. Operators of such repos (agent-pipeline itself among them) want to opt out of the remote re-run without losing verification.

## What Changes

- Add a top-level `ci_mode` config key to `.github/pipeline.yml`, an enum of `github` (default) and `local`. Unknown values are rejected at config-parse time.
- `ci_mode: github` (default) is unchanged: the pre-merge CI gate polls `gh pr checks`, runs the zero-check-run recovery path, and rebases on CI failure exactly as today.
- `ci_mode: local` changes only the pre-merge CI step: the gate SHALL NOT call `gh pr checks` (or any GitHub check-runs API) and SHALL instead verify the current run's recorded local test-gate outcome from the run store.
- **Fail-closed safety floor:** when `ci_mode: local` and no local test-gate result is present for the current run (run directory absent, test gate skipped/disabled, or the event log unreadable), the gate blocks to `needs-human` with a clear message rather than silently skipping verification. Local mode substitutes the authoritative local gate; it never advances with *zero* verification.
- The conflict pre-check, mergeability gate, and OpenSpec-validation gate in pre-merge are unaffected by `ci_mode` and still run in both modes. Only the GitHub Actions checks poll is replaced.
- The never-auto-merge safety floor is untouched: the pipeline still stops at `pipeline:ready-to-deploy`.

## Capabilities

### New Capabilities
<!-- None — this change augments existing capabilities only. -->

### Modified Capabilities
- `pipeline-configuration`: add the optional `ci_mode` key (enum `github`/`local`, default `github`) to `PartialConfigSchema` / `PipelineConfig` / `DEFAULT_CONFIG`, with strict enum validation and a `.describe()` annotation so it appears in the emitted JSON Schema.
- `pre-merge-ci-gate`: the gate's CI verification source is selected by `ci_mode`; `github` preserves every existing requirement verbatim, `local` verifies the current run's recorded test-gate outcome instead of polling `gh pr checks` and fails closed when no local result is present.

## Impact

- `core/scripts/types.ts` — add `ci_mode: "github" | "local"` to `PipelineConfig`; set `DEFAULT_CONFIG.ci_mode = "github"`.
- `core/scripts/config.ts` — add `ci_mode: z.enum(["github","local"]).optional().describe(...)` to `PartialConfigSchema`; resolve it in the `merged` config (`fileConfig.ci_mode ?? DEFAULT_CONFIG.ci_mode`); emit it (with an inline comment) in the `writeConfig` YAML scaffold and in the config-from-partial builder.
- `core/scripts/stages/pre_merge.ts` — branch the CI step (`Step 1`) on `cfg.ci_mode`; add a helper that reads the current run's most-recent test-gate outcome from the run store and an injectable `readRunEvents` deps seam for unit tests.
- `core/scripts/run-store.ts` — (optional) a small read helper that returns the latest `stage_accounting` event with `harness === "test-gate"` for a run directory; the test gate already records this event, so no new write path is added.
- `core/test/pre_merge.test.ts`, `core/test/config.test.ts` — unit tests for both modes, the failure case, the missing-result fail-closed fallback, and config enum validation.
- `plugin/` — regenerated mirror (`node scripts/build.mjs`) committed in the same change.
- `README.md` — document `ci_mode`, its default, and the operator responsibility (only enable `local` when the local gate is identical to CI; keep branch protection owned by the operator).

## Acceptance Criteria

- [ ] `ci_mode` is a valid `.github/pipeline.yml` key accepting `github` or `local`; any other value is rejected at config-parse time with an error naming `ci_mode`.
- [ ] `ci_mode` absent resolves to `"github"`, and pre-merge with `ci_mode: github` behaves exactly as today (polls `gh pr checks`, no-run recovery, CI-failure rebase all unchanged).
- [ ] Pre-merge with `ci_mode: local` does not call `getPrChecks` / the GitHub check-runs API at all.
- [ ] Pre-merge with `ci_mode: local` reads the current run's test-gate outcome from the run store and advances (to the mergeability/OpenSpec steps) when the most-recent recorded test-gate outcome is a pass.
- [ ] Pre-merge with `ci_mode: local` blocks to `needs-human` with a clear message when no test-gate result is present for the current run (run dir absent, test gate skipped, or log unreadable), and does not silently skip verification.
- [ ] Pre-merge with `ci_mode: local` does not advance when the most-recent recorded test-gate outcome is a failure.
- [ ] The conflict, mergeability, and OpenSpec-validation gates still run under `ci_mode: local` (a conflicting or spec-invalid PR still blocks).
- [ ] The JSON Schema emitted by `pipeline config schema` includes `ci_mode` with the `github`/`local` enum and a non-empty `description`.
- [ ] `openspec validate --all` passes for the change and the updated living specs.
- [ ] Unit tests cover both modes, the failure case, and the missing-result fail-closed fallback; each test fails without the corresponding code change.
