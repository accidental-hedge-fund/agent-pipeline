## Why

The pipeline creates a fresh git worktree for every issue but never runs the repository's package manager install inside it, so any JS/TS repo that does not vendor `node_modules` fails immediately when the test/build gate tries to invoke binaries (`pnpm run test`, `vitest`, etc.) that only exist after `pnpm install`. This blocks every first pipeline run in a fresh worktree for these repos — a P0 regression against the stated goal of working out-of-the-box.

## What Changes

- **New setup step**: after `createWorktree` and before the test/build gate, the pipeline detects and runs the repo's dependency install command (e.g. `pnpm install`, `npm ci`, `yarn install`) when a lockfile is present.
- **Config escape hatch**: a new `setup_command` field in `pipeline.yml` lets operators override the auto-detected install with an arbitrary shell script (for repos with multi-step setup beyond a simple install).
- The setup step is **skipped** when `setup_command` is set to an empty string (opt-out), when no lockfile is present, and when `node_modules` is already populated and `setup_command` is not explicitly set (idempotent fast-path).
- Failures in the setup step **block** the pipeline (surface immediately rather than producing a cryptic "command not found" from the test gate).

## Capabilities

### New Capabilities

- `worktree-dependency-install`: Detect and run the package manager install step (or a configured `setup_command`) in the worktree immediately after creation and before the first stage that needs binaries (the test/build gate). Covers auto-detection from lockfile, idempotency check, config override, and failure reporting.

### Modified Capabilities

- `worktree-lifecycle`: The worktree creation sequence SHALL invoke the dependency-install step as the final phase of bootstrap, so that the worktree is fully ready before any stage runs.
- `test-build-gate`: The test/build gate SHOULD document that it assumes the worktree is dependency-installed (the invariant is now guaranteed by `worktree-dependency-install`, not by the gate itself).

## Impact

- `core/scripts/stages/` — new stage helper or pre-gate function for the install step.
- `core/scripts/harness.ts` — wires the install step into the worktree bootstrap sequence.
- `core/scripts/config.ts` — adds optional `setup_command` field to the config schema.
- `openspec/specs/` — new `worktree-dependency-install/spec.md`; delta entries in `worktree-lifecycle` and `test-build-gate`.
- `hosts/` and `plugin/` mirrors must be regenerated after core changes.
- README — documents the new `setup_command` config key.
- No external API changes; no breaking changes to existing config (the new field is optional with auto-detection as the default).

## Acceptance Criteria

- [ ] A fresh pipeline run on a JS/TS repo with `pnpm-lock.yaml` succeeds at the test gate without any manual `pnpm install` step.
- [ ] A fresh pipeline run on a JS/TS repo with `package-lock.json` runs `npm ci` before the test gate.
- [ ] A fresh pipeline run on a JS/TS repo with `yarn.lock` runs `yarn install` before the test gate.
- [ ] When `node_modules` already exists and no `setup_command` is configured, the install step is skipped (idempotent fast-path — no redundant installs on subsequent runs).
- [ ] When `setup_command` is set in `pipeline.yml`, that command is run instead of auto-detection.
- [ ] When `setup_command` is set to `""`, the install step is skipped entirely (explicit opt-out).
- [ ] When no lockfile and no `setup_command` are present, the install step is skipped without error.
- [ ] When the install command exits non-zero, the pipeline blocks at the setup step with an actionable error message (not a cryptic "command not found" later).
- [ ] The install step result appears in the pipeline log/output so the operator can see what ran.
- [ ] `npm run ci` passes with the new code (unit tests cover auto-detection, idempotency, config override, and failure blocking; regression test fails without the fix).
