## Why

`maybeArchiveOpenspec` in `pre_merge.ts` calls `git commit` with `ignoreFailure: true` and never inspects the result before proceeding to `git push`. If the commit fails (e.g., a pre-commit hook rejects it, git is mis-configured, or the index is in a broken state), the push succeeds anyway — without the archive commit — so CI can report green on a branch that was never actually archived, silently skipping the spec-finalization gate.

## What Changes

- `core/scripts/stages/pre_merge.ts` (`maybeArchiveOpenspec`): capture the result of `git commit`; when a diff was produced but the commit exits non-zero, call `setBlocked` with the commit stderr and return `{ status: "blocked" }` without pushing.
- Leave the existing `git add -A` and `git push` error paths unchanged; this change adds only the missing guard between `git commit` and `git push`.

## Acceptance Criteria

- [ ] When the archive produces a diff and `git commit` exits non-zero, the issue is blocked with an actionable message that includes the commit stderr.
- [ ] No `git push` is attempted when the commit fails.
- [ ] When `git commit` succeeds, the existing push + waiting path is unchanged.
- [ ] A regression test exists: archive produces a diff, commit is faked to fail, no push path is taken, and the issue is blocked.

## Capabilities

### New Capabilities
_(none)_

### Modified Capabilities
- `openspec-integration`: add a requirement that a failed archive commit blocks the pre-merge gate with the commit stderr and prevents a push.

## Impact

- `core/scripts/stages/pre_merge.ts` — `maybeArchiveOpenspec` function; minimal one-path addition.
- `core/test/pre-merge.test.ts` (or equivalent) — new regression test case.
- No changes to `plugin/` beyond the regenerated mirror, `openspec/specs/`, or any other pipeline stage.
