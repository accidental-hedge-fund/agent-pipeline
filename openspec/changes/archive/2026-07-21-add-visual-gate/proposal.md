# Add a visual-gate stage (repo-defined E2E/visual verification with artifact evidence)

## Why

The README state-machine infographic (PR #335) shows a `visual-gate (E2E · VISUAL)` band between
the review/fix loop and the terminal gates, but the engine has no such stage: the gate band is
`pre-merge → eval-gate → shipcheck-gate → ready-to-deploy`. Today the only way to run E2E/visual
checks is to fold them into `eval_gate.command`, which conflates two different kinds of evidence —
a pass/fail eval score versus *reviewable visual artifacts* (screenshots, diffs, traces).

The human who owns the merge button at `ready-to-deploy` should be able to see what the change
actually looks like, not just that another suite exited 0. That requires a stage whose declared
output is an artifact bundle, not only an exit code.

## What Changes

- **New `visual_gate` config block** in `.github/pipeline.yml`, mirroring `eval_gate`:
  `enabled` (default `false`), `command` (required when enabled), `mode` (`gate` default /
  `advisory`), `timeout`, `max_attempts`, plus one addition — `artifacts_dir` (worktree-relative
  path the command writes screenshots/diffs/traces into). `visual_gate.enabled` and
  `visual_gate.mode` join the rigor-gating diagnostic paths so a typo can never silently flip the
  gate off.
- **New `visual-gate` stage** inserted in `STAGES` after `pre-merge` and before `eval-gate`,
  matching the infographic's relative order, with a `pipeline:visual-gate` label created by
  `pipeline --init` / `pipeline:init` and managed through the normal lifecycle.
- **Repo-defined command execution**: `sh -c` inside the issue's worktree, exit code alone decides
  pass/fail. The pipeline never parses output, never diffs images.
- **Run context passed as environment**: `PIPELINE_PR_NUMBER`, `PIPELINE_BRANCH`, `PIPELINE_ISSUE`,
  `PIPELINE_RUN_ID`, and `PIPELINE_VISUAL_ARTIFACTS_DIR` are exported to the command so a
  repo-defined suite can target its per-PR preview deployment (Vercel-style preview URL) rather
  than only a locally served build.
- **Artifact evidence capture**: after each run the stage enumerates `artifacts_dir`, copies the
  files into the run directory, and posts a `## Visual Gate` comment listing the captured artifacts
  alongside the outcome; the artifact manifest also lands in the issue's evidence bundle.
- **Recovery contract identical to eval-gate (#372)**: `gate` mode routes an ordinary failure to a
  bounded fix round with the gate name, command, and tail-biased output excerpt as fix context, then
  re-runs; exhausted attempts block with the final output. `advisory` mode records and always
  advances. Tooling failures (timeout, spawn error) block immediately in either mode.
- **Docs**: README Lifecycle section, config scaffold, and gate docs updated so the documented state
  machine and the infographic agree; includes a documented pattern for seeded test credentials
  supplied through the command's environment for auth-protected browser verification.

### Note on a body/comment tension

The issue body frames the gate as posting screenshots from a locally run suite; the human comment
asks for preview-deployment targeting. These are complementary, not conflicting, and both are in
scope: the pipeline exports run context so the repo's command may target a preview URL, and it
captures whatever artifacts the command writes either way. Choosing between a local build and a
preview deployment stays entirely inside the repo-defined command.

## Impact

- Affected specs: **visual-gate** (new capability), **pipeline-state-machine** (stage sequence).
- Affected code: `core/scripts/types.ts` (STAGES), `core/scripts/config.ts` (schema, defaults,
  scaffold, rigor-gating paths), `core/scripts/stages/visual.ts` (new), `core/scripts/pipeline.ts`
  (dispatch, label init), `core/scripts/stages/pre_merge.ts` (next stage), `core/scripts/harness.ts`
  (env seam on `runCapped`), `core/scripts/prompts/` (visual-fix prompt), `core/test/`, README, and
  the regenerated `plugin/` mirror.
- Rollback: `visual_gate: { enabled: false }` (the default).

## Acceptance criteria

- [ ] `.github/pipeline.yml` accepts a `visual_gate` block with `enabled`, `command`, `mode`,
      `timeout`, `max_attempts`, `artifacts_dir`; unknown keys are rejected by the strict schema
- [ ] `visual_gate.enabled` defaults to `false` when the block is absent, and `visual_gate.mode`
      defaults to `gate`
- [ ] `visual_gate.enabled: true` with no `command` produces a config **error** diagnostic
- [ ] `visual_gate.enabled` and `visual_gate.mode` are rigor-gating paths: a malformed value is an
      error diagnostic, never a silent demotion to disabled/advisory
- [ ] `STAGES` contains `visual-gate` at an index greater than `pre-merge` and less than `eval-gate`
- [ ] The orchestrator dispatch table routes `pipeline:visual-gate` to the visual stage handler
- [ ] `pipeline --init` creates the `pipeline:visual-gate` label
- [ ] With `visual_gate.enabled` false, the stage transitions straight to `eval-gate` with a
      "step disabled" log line, spawns no child process, posts no comment, and applies no artifacts
- [ ] When enabled, the command runs via `sh -c` with the issue worktree as cwd
- [ ] The command's environment contains `PIPELINE_PR_NUMBER`, `PIPELINE_BRANCH`, `PIPELINE_ISSUE`,
      `PIPELINE_RUN_ID`, and `PIPELINE_VISUAL_ARTIFACTS_DIR`
- [ ] Exit code 0 is a pass, any non-zero is a fail; no pipeline-side parsing or image diffing
- [ ] After each run the stage posts a `## Visual Gate` comment stating mode, outcome (PASS/FAIL),
      elapsed time, a tail-biased output excerpt, and a list of the captured artifact paths
- [ ] Captured artifacts are copied under the run directory and recorded in the evidence bundle
- [ ] An empty or missing `artifacts_dir` yields an explicit "no artifacts captured" note and does
      not by itself change the pass/fail outcome
- [ ] `mode: gate` + ordinary failure with budget remaining invokes the implementer harness with the
      gate name, command, and bounded output as context, then re-runs the command
- [ ] `mode: gate` + ordinary failure with budget exhausted calls `setBlocked` with the final output
      and does not advance
- [ ] A gate pass reached after a visual-fix commit landed routes back to `pre-merge`, not forward
- [ ] `mode: advisory` records the result comment and advances regardless of exit code, invoking no
      fix round
- [ ] Timeout or spawn error blocks immediately in either mode and triggers no fix round
- [ ] README Lifecycle section, config scaffold, and gate docs list `visual-gate` between
      `pre-merge` and `eval-gate`, and document the auth-protected browser-verification pattern
- [ ] Unit tests cover the above via the existing dependency-seam pattern with no real network, git,
      or subprocess calls
- [ ] `npm run ci` passes with the regenerated `plugin/` mirror committed
