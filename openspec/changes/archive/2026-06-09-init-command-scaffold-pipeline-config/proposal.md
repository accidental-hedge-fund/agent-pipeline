## Why

Adopting the pipeline on a fresh repo today has a chicken-and-egg problem: `pipeline:ready` must exist before you can opt an issue in, but labels are only auto-created on the first real stage advance. There is also no way to produce a starter `.github/pipeline.yml` — adopters must infer which keys exist from source code. A single `init` command resolves both in one explicit, safe, re-runnable step.

## What Changes

- **New `init` sub-command** in the pipeline CLI (`/pipeline init` / `$pipeline init`) that runs without an issue number and advances no stage.
- `init` calls `ensurePipelineLabels` to idempotently create all pipeline labels (`pipeline:<stage>`, `pipeline:blocked`, `harness:claude`, `harness:codex`) in the target repo.
- `init` writes a commented `.github/pipeline.yml` containing every commonly-overridden key at its default value, ready to edit — but **skips writing (prints a notice) if the file already exists**.
- README gains an "Onboarding a new repo" section that names `init` as the recommended first step.
- Unit tests cover: label-ensure path, config-scaffold-when-absent, no-clobber-when-present, and scaffolded-config validity.

## Capabilities

### New Capabilities
- `init-command`: Pipeline CLI `init` sub-command — ensures labels and optionally scaffolds `.github/pipeline.yml` without advancing any issue or stage.

### Modified Capabilities

*(none — init is purely additive; the existing advance/status/unblock/cleanup dispatch and `ensurePipelineLabels` are unchanged)*

## Impact

- `core/scripts/pipeline.ts` — add `init` mode to the CLI option parser and dispatch it before any issue-number check.
- `core/scripts/config.ts` — add `scaffoldDefaultConfig(repoDir)` that writes the commented template; has no side-effects if the file exists.
- `core/scripts/gh.ts` — `ensurePipelineLabels` is reused as-is; no changes required.
- `README.md` — new onboarding section documents `init` as the recommended first step.
- Test coverage in `core/scripts/__tests__/` (new test file co-located with config.ts or pipeline.ts).
