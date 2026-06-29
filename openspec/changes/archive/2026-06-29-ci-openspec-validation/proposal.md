## Why

This repo treats OpenSpec as an active planning and review contract, not passive
documentation. The pipeline validates OpenSpec during planning and at pre-merge, but the
GitHub Actions gate runs `npm run ci`, and `npm run ci` does **not** run
`openspec validate --all`.

That leaves a gap for human-authored commits, manual cleanup commits, or other
non-pipeline changes: CI can be green while `openspec/` is structurally invalid. The
pipeline may catch it later at pre-merge, but by then the failure is farther from the
change that introduced it. Closing the gap makes structural OpenSpec validity part of the
normal repo gate, so an invalid living spec or active change fails CI at the source.

## What Changes

- Add an OpenSpec validation step to the repo's full CI gate (`npm run ci`) that runs
  `openspec validate --all` whenever an `openspec/` workspace is present.
- Keep the gate inside the `ci` npm script (a new `ci:openspec` sub-step) rather than as a
  bespoke `.github/workflows/ci.yml` step, preserving the single-source-of-truth
  convention that `ci.yml` runs `npm run ci` verbatim.
- Make the step a no-op (exit 0) when the repository has no `openspec/` directory, so the
  gate never forces OpenSpec onto contexts (including the install smoke test) that do not
  use it.
- Resolve the `openspec` CLI so the step succeeds on a fresh CI runner that does not have
  the CLI preinstalled.
- Document the new gate in the build/test guidance: `README.md`, `CLAUDE.md`, and
  `AGENTS.md`.
- Add tests proving the `ci` script wires the OpenSpec step and that the step no-ops
  without an `openspec/` workspace.

## Acceptance Criteria

- [ ] `npm run ci` runs `openspec validate --all` when an `openspec/` directory exists at
  the repo root.
- [ ] CI (`npm run ci`, and therefore `.github/workflows/ci.yml`) exits non-zero when any
  living spec under `openspec/specs/` or any active change under `openspec/changes/` is
  structurally invalid; a regression test demonstrates the failure.
- [ ] The OpenSpec validation step exits 0 (no-op) when no `openspec/` directory exists;
  the install smoke test and non-OpenSpec usage are unaffected.
- [ ] The step runs successfully on a GitHub Actions runner that has no preinstalled
  `openspec` CLI (the CI run for this change's PR is green).
- [ ] `README.md`, `CLAUDE.md`, and `AGENTS.md` build/test sections state that
  `npm run ci` validates the OpenSpec workspace.
- [ ] A test asserts the `ci` npm script includes the OpenSpec validation step, and a test
  asserts the step no-ops without an `openspec/` workspace; both fail without the change.
- [ ] `node scripts/build.mjs --check` passes and `openspec validate --all` (including this
  change) passes.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `test-gate-ci-parity`: extend the description of what this repo's `npm run ci` / `ci.yml`
  CI surface covers to include `openspec validate --all`, conditional on an `openspec/`
  workspace and documented in the build/test guidance.

## Impact

- `package.json` `ci` script chain (adds a `ci:openspec` sub-step).
- A new guard script under `scripts/` that runs the conditional OpenSpec validation.
- New `scripts/*.test.mjs` coverage (drift guard on the `ci` chain; no-op-without-workspace
  behavior).
- `README.md`, `CLAUDE.md`, `AGENTS.md` build/test guidance.
- No change to `.github/workflows/ci.yml` step logic (it still runs `npm run ci`).
- No change to OpenSpec semantics or the engine's planning/pre-merge OpenSpec behavior.
