## Why

`npm run ci` is the declared full gate (core tests → mirror check → install smoke → launcher smoke), but `.github/workflows/ci.yml` manually enumerates only the first three steps — omitting `ci:launcher-smoke`. A launcher regression that breaks `scripts/launcher-smoke.mjs` will pass GitHub CI while failing locally, defeating the invariant that CI and local are equivalent.

## What Changes

- `.github/workflows/ci.yml`: replace the four manually-enumerated steps (Core test suite, Generated plugin is up to date, Install smoke test, and a missing launcher smoke step) with a single `npm run ci` invocation. The root `ci` script is the single source of truth; enumerating steps in the YAML duplicates it and creates drift.

## Acceptance Criteria

- [ ] `.github/workflows/ci.yml` invokes `npm run ci` as its sole test step (or an equivalent that includes all four sub-commands including `ci:launcher-smoke`).
- [ ] A CI run logs output from the launcher smoke step (`launcher smoke: N passed, 0 failed`).
- [ ] Introducing a deliberate regression in `scripts/launcher-smoke.mjs` (or removing the script) causes the CI job to fail.
- [ ] Local `npm run ci` and GitHub Actions CI cover the same set of checks.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `test-gate-ci-parity`: add a requirement that the GitHub Actions CI workflow for this repo SHALL run `npm run ci` (the canonical full CI surface), so CI and the pipeline test gate are backed by the same gate definition.

## Impact

- `.github/workflows/ci.yml` — the only file that changes; the step list is replaced by `npm run ci`.
- No changes to `core/`, `scripts/`, `plugin/`, or any pipeline logic.
