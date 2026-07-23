## 1. Discovery classification

- [ ] 1.1 In `core/scripts/stages/release.ts`, add a `ReleaseDeps` seam that classifies a
  candidate number as `pr` | `not-a-pr` | `error` from the `gh pr view <N>` result
  (match GitHub's "Could not resolve to a PullRequest" / pulls-404 class as `not-a-pr`;
  everything else non-zero as `error`).
- [ ] 1.2 In `discoverShippedPRs`, when enriching candidates in live mode, drop
  `not-a-pr` numbers from the shipped set and emit a warning naming the excluded number.
  Trust `Merge pull request #N` numbers as PRs without classification.
- [ ] 1.3 Preserve the `localOnly` (dry-run) path unchanged — no GitHub calls.

## 2. Abort semantics preserved

- [ ] 2.1 Ensure a `not-a-pr` candidate never reaches `collectShippedIssueNumbers` (no
  closing-issue lookup, no Shipped row).
- [ ] 2.2 Keep the genuine-failure path setting `hadFailures` so a real API failure on a
  real PR still triggers the existing issue-discovery abort.

## 3. Tests

- [ ] 3.1 Regression test: a docs-style subject ending in a single `(#N)` issue reference
  in the range, where `gh` reports `#N` is not a PR — assert the release does not abort,
  `#N` is excluded from the shipped set, and a warning is emitted. Prove it fails without
  the fix (currently aborts).
- [ ] 3.2 Test: a genuine API failure (network/auth) on a real PR still aborts.
- [ ] 3.3 Test: `Merge pull request #N` numbers are trusted and not excluded.

## 4. Mirror & gate

- [ ] 4.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 4.2 `npm run ci` green (core tests, mirror `--check`, install smoke, openspec
  validate).
