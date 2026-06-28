# Issue #301 Review 2 Fix Plan

## Goal

Address the blocking adversarial-review finding that `pipeline scoreboard --days N`
without `--since` or `--until` reports an N-day window but scans the default
30-day span.

## Checklist

- [x] Inspect the scoreboard window parser and adjacent tests.
- [x] Update `parseScoreboardWindow` so days-only windows use `--days`.
- [x] Add a regression test asserting the actual since-to-until span for `--days`.
- [x] Run `node scripts/build.mjs` after core edits and include regenerated `plugin/`.
- [x] Run targeted scoreboard tests from `core`.
- [x] Run `npm run ci` from the repo root.
- [ ] Perform the pre-commit self-check, document review results, and commit with the required trailers.

## Review Results

- OpenSpec delta already describes configurable `--days` windows and the
  no-window 30-day default; no spec edit required.
- Targeted verification passed: `node --test --experimental-strip-types test/scoreboard.test.ts`.
- Full verification passed: `npm run ci`.
- Diff hygiene passed: `git diff --check`.
- Pre-commit self-check found no broader change and no higher-severity issue
  introduced by this diff.
- Commit blocked by sandbox permissions: `git add` could not create
  `.git/worktrees/pipeline-301-factory-scoreboard-for-autonomous-develo/index.lock`
  (`Operation not permitted`).
