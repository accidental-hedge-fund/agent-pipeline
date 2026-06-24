## Why

`pipeline merge` calls `gh pr checks <pr> --required` to gate on branch-protection required checks. On a repo where the base branch has no required checks configured, that command exits non-zero with "no required checks reported", and the handler treats it as a hard failure — blocking every merge even when CI is green, the PR is `MERGEABLE`/`CLEAN`, and it carries `pipeline:ready-to-deploy`. The agent-pipeline repo itself has no required checks, so every merge must fall back to a manual `gh pr merge --squash`.

## What Changes

- `merge.ts`: detect the "no required checks configured" exit from `gh pr checks --required` and, instead of aborting, enter a fallback safety path that verifies: (1) the PR carries `pipeline:ready-to-deploy`, (2) `gh pr checks <pr>` (without `--required`) shows no `fail`/`pending`/`cancel` buckets, and (3) `mergeable == MERGEABLE` and `mergeStateStatus == CLEAN`. If all three hold, the handler proceeds to squash-merge; otherwise it blocks with an actionable message.
- `merge.ts` `MergeDeps`: add a `ghPrChecksAll` injectable for the no-`--required` fallback call so the new path remains fully unit-testable without subprocesses.
- Unit tests covering the three new scenarios: no-required + all-green → proceed; no-required + a failing check → block; and the existing required-checks-present path → unchanged.

## Capabilities

### New Capabilities
- (none — this change modifies an existing capability only)

### Modified Capabilities
- `merge-sub-command`: The required-status-checks gate SHALL handle the "no required checks configured" case by falling back to a non-required checks + mergeability safety check instead of hard-failing.

## Impact

- `core/scripts/stages/merge.ts` — gate logic and `MergeDeps` interface.
- `core/test/merge.test.ts` — three new unit-test scenarios.
- No changes to state-machine labels, config schema, or any other stage.

## Acceptance Criteria

- [ ] When `gh pr checks --required` exits with the "no required checks reported" message, `pipeline merge` does NOT abort; it enters the fallback path.
- [ ] Fallback path: all of `gh pr checks` (non-required) returning only `pass`/`skipping` buckets AND `mergeable == MERGEABLE` AND `mergeStateStatus == CLEAN` AND issue carrying `pipeline:ready-to-deploy` → squash-merge proceeds.
- [ ] Fallback path: any non-required check with `fail`, `pending`, or `cancel` bucket → handler exits non-zero with a message naming the offending check(s); no merge executed.
- [ ] When required checks ARE configured and all pass, the existing behavior is unchanged (no regression).
- [ ] When required checks ARE configured and any fail/pending, the existing block behavior is unchanged.
- [ ] The `ghPrChecksAll` fallback call is injectable via `MergeDeps`; unit tests cover it with no real subprocess calls.
- [ ] `npm run ci` passes with no regressions.
