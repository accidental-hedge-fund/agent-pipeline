## Why

Today, setup defects (missing CLIs, stale plugin mirror, bad GitHub auth, wrong package install state) are discovered mid-run by the harness or test gate — after planning, implementation tokens, and time have already been spent. A fast, deterministic `doctor` preflight surfaces them before the agent loop begins, giving the maintainer a clear "this repo is runnable" signal and actionable remediation text when it is not.

## What Changes

- New `doctor` standalone CLI command (`pipeline doctor`) that runs all preflight checks and reports pass/fail with remediation text.
- New opt-in run-start preflight phase: when `doctor.runOnStart: true` is configured (or `--doctor` flag is passed), the checks run before planning begins; a failure stops the run with a non-zero exit and a human-readable error — no planning, no implementation, no tokens consumed.
- Checks performed (all deterministic, no model calls):
  - Required CLIs present and executable (`gh`, `node`, `openspec` if configured).
  - GitHub auth valid and has access to the configured repo (`gh auth status` + `gh repo view`).
  - Working tree / worktree cleanliness: no uncommitted changes on protected branches.
  - Configured harnesses are reachable (e.g. `claude` CLI, `codex` CLI present when declared in config).
  - Package install state: `node_modules` exists and `package.json` matches (lock-file freshness check via mtime).
  - OpenSpec available when `openspec.enabled: true` in config.
  - Declared eval command present when `evalCommand` is configured.
- Latest preflight result is surfaced by `--status`.

## Capabilities

### New Capabilities

- `doctor-preflight`: The pipeline exposes a `doctor` command and optional run-start preflight phase that checks required CLIs, GitHub auth and repo access, worktree cleanliness, configured harness availability, package install state, and optional OpenSpec/eval command availability; it produces actionable remediation text and blocks the run on failures.

### Modified Capabilities

- `pipeline-configuration`: Config schema gains an optional `doctor` block (`runOnStart`, `failFast`) that controls preflight behavior.

## Impact

- New `core/scripts/stages/doctor.ts` (preflight logic with injectable deps).
- `core/scripts/pipeline.ts`: new `doctor` subcommand; `--doctor` flag; `--status` surfaces latest preflight result.
- `core/scripts/config.ts`: optional `doctor` config block.
- New `core/test/doctor.test.ts`.
- `plugin/` mirror regenerated after all `core/` changes.
- No changes to state-machine edges, review stages, or existing run flow when preflight is not enabled.

## Acceptance Criteria

- [ ] `pipeline doctor` runs all checks, emits a pass/fail summary with per-check status, and exits non-zero on any failure.
- [ ] Each failing check includes at minimum one sentence of actionable remediation text (what to run or fix).
- [ ] With `doctor.runOnStart: true` or `--doctor`, a failing preflight stops the run before planning; no planning or fix tokens are consumed.
- [ ] With `doctor.runOnStart: false` (default) or no flag, existing runs are completely unchanged.
- [ ] `pipeline --status` surfaces the latest preflight result when one is available.
- [ ] All checks are deterministic and invoke no model.
- [ ] Unit tests cover: each individual check (pass + fail), `runOnStart` integration (blocked vs. proceeds), and `--status` output when a result exists vs. when none exists.
- [ ] `npm run ci` passes (mirror in sync, all tests green).
