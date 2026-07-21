# Tasks — visual-gate

## 1. Config surface

- [x] 1.1 Add the strict `visual_gate` Zod block to `core/scripts/config.ts` (`enabled`, `command`,
      `mode`, `timeout`, `max_attempts`, `artifacts_dir`) with describe strings matching the
      `eval_gate` style
- [x] 1.2 Add `DEFAULT_CONFIG.visual_gate` (`enabled: false`, `mode: "gate"`, `timeout: 900`,
      `max_attempts: 2`, `artifacts_dir: ".pipeline-visual"`) and the merge branch in the config loader
- [x] 1.3 Add `visual_gate.enabled` and `visual_gate.mode` to `RIGOR_GATING_PATHS`
- [x] 1.4 Emit an error diagnostic when `enabled: true` and `command` is absent/empty, and when
      `artifacts_dir` escapes the worktree root
- [x] 1.5 Extend the `.github/pipeline.yml` scaffold writer with the commented `visual_gate` block
- [x] 1.6 Tests: defaults, explicit values, missing-command error, rigor-gating diagnostics,
      scaffold round-trip

## 2. State machine

- [x] 2.1 Insert `"visual-gate"` into `STAGES` between `"pre-merge"` and `"eval-gate"` in
      `core/scripts/types.ts`
- [x] 2.2 Route `pipeline:visual-gate` to the new handler in the orchestrator dispatch table
- [x] 2.3 Point `pre-merge`'s success transition at `visual-gate`
- [x] 2.4 Ensure `pipeline --init` / `pipeline:init` creates the `pipeline:visual-gate` label
- [x] 2.5 Tests: STAGES ordering, dispatch routing, label creation

## 3. Harness env seam

- [x] 3.1 Add an optional `env` record to `runCapped` options, merged over `process.env`
- [x] 3.2 Test that absent `env` preserves today's inheritance behavior (no existing caller changes)

## 4. Stage implementation

- [x] 4.1 Create `core/scripts/stages/visual.ts` with a `VisualGateDeps` seam (gh wrappers, worktree
      lookup, command runner, artifact reader/copier, harness invoke) mirroring the eval stage
- [x] 4.2 Disabled path: transition `visual-gate → eval-gate` with a skip log line; no spawn, no
      comment, no artifacts
- [x] 4.3 Enabled path: run `visual_gate.command` via `sh -c` in the issue worktree with the
      `PIPELINE_*` env vars set; exit code is the sole verdict
- [x] 4.4 Artifact capture: resolve and containment-check `artifacts_dir`, enumerate deterministically
      under bounded count/size, copy to `<runDir>/visual/attempt-<n>/`, build the manifest
- [x] 4.5 Post the `## Visual Gate` comment (mode, outcome, elapsed, tail-biased excerpt, artifact
      manifest or an explicit "no artifacts captured" note) and record the manifest in the evidence bundle
- [x] 4.6 Gate mode: ordinary failure with budget remaining → visual-fix round (new prompt template
      in `core/scripts/prompts/`) → verified push → re-run; budget exhausted → `setBlocked`
- [x] 4.7 Gate-mode pass following an unreviewed visual-fix commit → transition to `pre-merge`,
      derived from GitHub PR state
- [x] 4.8 Advisory mode: post the result comment and advance to `eval-gate` regardless of exit code
- [x] 4.9 Tooling failures (timeout, spawn error) → `setBlocked` immediately in either mode, no fix round
- [x] 4.10 Route secrets through the existing sanitizer before any comment/artifact record is written

## 5. Tests

- [x] 5.1 `core/test/visual-gate.test.ts`: disabled skip, pass/advance, gate fail → fix round → re-run
      pass → pre-merge, budget exhausted → blocked, advisory fail → advance, timeout blocks,
      spawn error blocks
- [x] 5.2 Artifact tests: manifest content, empty/missing dir note, bound truncation, path-escape rejection
- [x] 5.3 Env-var test: the runner receives `PIPELINE_PR_NUMBER` / `PIPELINE_BRANCH` / `PIPELINE_ISSUE` /
      `PIPELINE_RUN_ID` / `PIPELINE_VISUAL_ARTIFACTS_DIR`
- [x] 5.4 Confirm every new test bites (fails without the corresponding change)

## 6. Docs & mirror

- [x] 6.1 README: Lifecycle section, state-machine table, and config scaffold list `visual-gate`
      between `pre-merge` and `eval-gate`, reconciling the text with the PR #335 infographic
- [x] 6.2 README: gate docs with a Playwright example targeting a per-PR preview deployment via
      `PIPELINE_PR_NUMBER` / `PIPELINE_BRANCH`, and the auth-protected pattern using seeded test
      credentials supplied through the command's environment
- [x] 6.3 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror
- [x] 6.4 `openspec validate --all` and `npm run ci` green from the repo root
