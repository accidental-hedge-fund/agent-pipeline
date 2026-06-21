# PR #277 Recovery Plan

## Goal

Salvage issue #258 / PR #277 by keeping the fast on-disk worktree lookup changes and removing the unfinished `RunStateCache` scope that caused the OpenSpec spec-divergence block.

## Checklist

- [x] Confirm current PR branch and latest `origin/main` state.
- [x] Rebase or merge PR branch onto latest `origin/main`; resolve conflicts without dropping newer main behavior.
- [x] Remove or de-scope `RunStateCache` implementation, tests, and OpenSpec promises while preserving `getOnDiskForIssue` behavior.
- [x] Update `openspec/changes/fast-worktree-lookup-cache-status/specs/**` and `tasks.md` to match the narrower fast-lookup implementation.
- [x] Keep/adjust tests that prove known-issue path lookup uses on-disk records and does not fan out through active-state GitHub calls.
- [x] Run `node scripts/build.mjs` after core edits and include generated `plugin/` mirror updates.
- [x] Run `openspec validate fast-worktree-lookup-cache-status`.
- [x] Run `node scripts/build.mjs --check`.
- [x] Run `npm run ci`.
- [x] Review final diff for unintended cache/stage-interface scope and document results.

## Review Notes

- `RunStateCache` implementation, tests, generated mirror file, and OpenSpec requirements were removed from scope.
- `getOnDiskForIssue` and known-issue path lookup migrations remain.
- Verification passed:
  - `node --test --experimental-strip-types test/worktree-fast-lookup.test.ts`
  - `openspec validate fast-worktree-lookup-cache-status`
  - `node scripts/build.mjs --check`
  - `npm run ci`
