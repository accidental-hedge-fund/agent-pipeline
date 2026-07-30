# README MIT license

## Plan
- [x] 1. Confirm the canonical license text in `LICENSE`
- [x] 2. Replace the abbreviated README license with the complete MIT text
- [x] 3. Verify the README diff and run repository checks
- [x] 4. Commit, push, open a PR against `main`, and confirm CI is green

## Review

### What changed
- Replaced the abbreviated `MIT © AHF` README entry with the complete canonical MIT license text from `LICENSE`.

### Verification
- `diff -u LICENSE <(sed -n '/^## License$/,$p' README.md | tail -n +3)` — exact match.
- `git diff --check` — passed.
- `npm run ci` — passed.

---

# #623 getPrForIssue open-PR pagination

## Plan
- [x] 1. Replace `gh pr list -L 100` in `getPrForIssue` with paginated GraphQL open-PR enumeration + injectable `GhApiRunner`
- [x] 2. Export mapper helper; fail visibly if safety page bound hit mid-list
- [x] 3. Regression tests: match on later page, exhausted null, no `-L 100` pr list path
- [x] 4. Prove bite (single-page stop fails multi-page test)
- [x] 5. `node scripts/build.mjs` + `npm run ci` + commit

## Review

### What changed
- `getPrForIssue` now paginates open PRs via GraphQL (`pullRequests(first:100,states:OPEN)`) with `number`, `headRefName`, `isCrossRepository`, and `closingIssuesReferences`, then runs existing dual-strategy `resolvePrForIssue`.
- Optional third-arg `GhApiRunner` for unit tests (defaults to production `ghRun`).
- Safety bound: 50×100 pages; throws on mid-list truncation instead of silent `null`.
- Regression tests in `gh-parsers.test.ts`; plugin mirror regenerated.

### Verification
- Bite probe: single-page stop → multi-page test fails (`null !== 42`).
- `npm run ci` green.
