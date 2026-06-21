## Why

The pre-merge gate pushes an OpenSpec archive commit, then polls `gh pr checks` for
the head SHA until CI passes. If GitHub Actions never fires a `pull_request:
synchronize` event for that commit — an occasional non-trigger — the checks list
stays perpetually "pending" (required checks are expected but no run exists). The
gate has no run to observe and polls until `ci_timeout` (default 900 s), then blocks
with a generic timeout error, even though the archive diff touches only
`openspec/` paths and the immediately-preceding commit's CI was already green.

Confirmed on PR #280 (issue #260): `gh api .../commits/d2bffb27/check-runs` returned
`total_count: 0`; the prior SHA `fef6cabc` had a successful run. Manual recovery
required `gh pr close 280 && gh pr reopen 280` to re-fire `pull_request: reopened`.

## What Changes

- `core/scripts/gh.ts`: add `getHeadCheckRunCount(cfg, sha)` — wraps
  `gh api repos/.../commits/<sha>/check-runs --jq .total_count` to detect "zero
  actual runs" vs "runs exist but are pending".
- `core/scripts/stages/pre_merge.ts`: in the CI-poll path, after a configurable
  **no-run grace window** (`ci_no_run_grace_s`, default 60 s), if the head SHA has
  zero check-runs AND the archive diff touches only `openspec/` paths AND the
  pre-archive SHA already had green CI, invoke **close+reopen** via `gh pr close` +
  `gh pr reopen` to re-fire the `pull_request` event, then resume polling. If no
  pre-archive SHA information is available, surface a clear actionable error
  ("no CI run detected; try closing and reopening the PR") rather than silently
  waiting out `ci_timeout`.
- `core/scripts/config.ts`: add `ci_no_run_grace_s` config key (default 60).
- Tests: unit tests for `getHeadCheckRunCount` (fake gh deps), and for the no-run
  recovery branch in `advancePreMerge` (fake deps returning zero check-run count,
  archive-only diff, prior SHA green → close+reopen called; non-archive diff → clear
  error, no close+reopen).

## Capabilities

### New Capabilities
- `pre-merge-ci-no-run-recovery`: When the CI gate detects zero check-runs on the
  head SHA after the grace window AND the diff is archive-only AND the prior commit
  was green, the gate SHALL automatically close and reopen the PR to re-fire CI,
  then resume polling. When the diff is not archive-only, the gate SHALL surface a
  clear actionable error instead of timing out silently.

### Modified Capabilities
- `pre-merge-ci-gate`: The CI-poll path gains a zero-run detection branch that
  fires before the existing "pending checks" wait path, triggering recovery instead
  of a silent `ci_timeout`.

## Impact

- `core/scripts/gh.ts` — one new exported async function (`getHeadCheckRunCount`).
- `core/scripts/stages/pre_merge.ts` — zero-run detection + close/reopen path inside
  the CI polling step; injectable deps for testing.
- `core/scripts/config.ts` — one new config key (`ci_no_run_grace_s`).
- Co-located tests in `core/test/pre_merge.test.ts` and `core/test/gh.test.ts`.
- No changes to state-machine edges, review stages, or any other pipeline stage.

## Acceptance Criteria

- [ ] After the archive commit is pushed, if `gh api .../commits/<sha>/check-runs`
  returns `total_count: 0` for at least `ci_no_run_grace_s` seconds, the gate
  detects "no run" (not "pending runs") and enters the recovery path.
- [ ] When the archive diff is openspec-only AND the pre-archive SHA had at least one
  passing check-run, the gate calls `gh pr close <N>` then `gh pr reopen <N>` and
  resumes polling without manual intervention.
- [ ] When the archive diff is NOT openspec-only (or the pre-archive SHA cannot be
  determined), the gate surfaces an actionable error message ("no CI run detected;
  try closing and reopening the PR") and does NOT block with a generic timeout.
- [ ] The normal case (check-runs exist, pending→pass) is entirely unchanged.
- [ ] The close+reopen path is exercised by a unit test using fake deps returning
  zero check-run count; the test confirms close and reopen are called and that
  polling resumes.
- [ ] `ci_no_run_grace_s` is a config key with a default of 60 s; setting it to 0
  skips the grace window.
- [ ] `npm run ci` passes with no regressions.
