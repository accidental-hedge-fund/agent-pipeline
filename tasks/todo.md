# Issue #301 Review 1 Fix Plan

## Goal

Address the blocking standard-review finding that scoreboard gate pass rates
inflate disabled and advisory-failed gates by reading a real gate verdict signal
instead of treating stage advancement as a pass.

## Checklist

- [x] Inspect current scoreboard gate aggregation, real eval/shipcheck artifact writers, and existing scoreboard tests.
- [x] Update gate pass-rate derivation minimally so disabled advances count as skipped and advisory failures count as failures when artifacts prove the verdict.
- [x] Add regression fixtures/tests using artifact shapes the pipeline actually writes for disabled gates and advisory failures.
- [x] Decide whether the existing OpenSpec delta needs a narrow update for the clarified behavior.
- [x] Run `node scripts/build.mjs` after core edits and include regenerated `plugin/`.
- [x] Run `openspec validate factory-scoreboard`.
- [x] Run targeted scoreboard tests from `core`.
- [x] Run `npm run ci` from the repo root.
- [ ] Perform the pre-commit self-check, document review results, and commit with the required trailers.

## Review Results

- OpenSpec delta already describes disabled gate skips outside the pass-rate denominator; no spec edit required.
- Targeted verification passed: `node --test --experimental-strip-types test/scoreboard.test.ts test/eval.test.ts test/shipcheck.test.ts`.
- Full verification passed: `npm run ci`.
- Pre-commit self-check found no higher-severity issue introduced by the diff.
- Commit blocked by sandbox permissions: `git commit` could not create `.git/worktrees/pipeline-301-factory-scoreboard-for-autonomous-develo/index.lock` (`Operation not permitted`).
