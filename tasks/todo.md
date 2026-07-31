# #771 — pre-merge CI settled failure must not thrash

## Status
Implementation complete. OpenSpec tasks all checked; `npm run ci` green.

## Plan artifacts
- `openspec/changes/pre-merge-ci-settled-failure-no-thrash/` (proposal, design, tasks, specs)

## Done
- Durable per-head rebase markers (`ciRebaseAttemptedForSha`) + terminal fail marker
- HEAD-moved truthfulness for CI ladder, BEHIND, and conflict recovery
- Thrash regressions in `core/test/pre-merge-ci-recovery.test.ts`
- Regenerated `plugin/` mirror
