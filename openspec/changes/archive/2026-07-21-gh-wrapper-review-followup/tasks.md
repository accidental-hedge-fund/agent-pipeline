## 1. Add shared gh.ts helpers

- [ ] 1.1 Add `createIssue(cfg, title, body, labels): Promise<number>` to `core/scripts/gh.ts`, delegating to `ghRun` with `gh issue create` args and parsing the returned URL for the issue number
- [ ] 1.2 Add `addIssueComment(cfg, issueNumber, body): Promise<void>` to `core/scripts/gh.ts`, delegating to `ghRun` with `gh issue comment` args
- [ ] 1.3 Write unit tests for both helpers in the nearest co-located test file (fake `ghRun` via the existing I/O seam pattern), covering: correct arg construction, issue-number extraction, non-zero-exit error, and timeout propagation

## 2. Update review.ts to use the new helpers

- [ ] 2.1 Rewrite `defaultCreateIssue` in `core/scripts/stages/review.ts` to delegate to the new `gh.ts` `createIssue` helper; remove all `spawnSync` logic from this closure
- [ ] 2.2 Rewrite `defaultAddIssueComment` in `core/scripts/stages/review.ts` to delegate to the new `gh.ts` `addIssueComment` helper; remove all `spawnSync` logic from this closure
- [ ] 2.3 Remove the `spawnSync` import from `review.ts` (verify no other call sites remain first)

## 3. Verify and finalize

- [ ] 3.1 Run `npm run ci` from the repo root and confirm all tests pass (including existing review-ceiling and follow-up tests)
- [ ] 3.2 Regenerate the plugin mirror: `node scripts/build.mjs` and commit the updated `plugin/` together with the `core/` changes
