## Why

`discoverShippedPRs` treats the last `(#N)` on any commit subject in the release range
as a squash-merge PR number. A non-PR commit whose subject ends in a single issue
reference — e.g. a release-prep docs commit `docs: add v1.21.0 release-plan row to
ROADMAP (#451)` — is mis-parsed as PR #451. During `pipeline release`, `gh pr view 451`
then fails ("Could not resolve to a PullRequest") because 451 is an *issue*, and
`collectShippedIssueNumbers` sets `hadFailures`, aborting the release with
"issue discovery failed" (observed 2026-07-21 on the v1.21.0 cut). The only workaround
was to hand-amend the commit subject. Multi-issue suffixes like `(#433, #434)` never
matched the regex, which hid the bug until a single-issue milestone surfaced it.

## What Changes

- Release PR discovery becomes **tolerant of non-PR `(#N)` references**: a candidate PR
  number that GitHub reports is *not a pull request* is dropped from the shipped-PR set
  with a warning, instead of aborting the release. Such a number contributes no Shipped
  table row and no closing-issue lookup.
- The distinction between a **non-PR reference** (a false-positive parse of an issue
  suffix in a non-PR commit) and a **genuine GitHub API failure** (network / auth /
  rate-limit) is preserved: only the latter still triggers the existing
  issue-discovery abort. Rigor against real API failures is not weakened.
- Numbers parsed from unambiguous `Merge pull request #N` merge-commit subjects remain
  trusted as PRs (they are definitionally PRs) and need no validation.
- A regression test with a docs-style subject ending in a single `(#N)` issue reference
  in the release range proves the release no longer aborts.

## Acceptance Criteria

- [ ] With a release range containing a non-PR commit whose subject ends in a single
  `(#N)` issue reference (e.g. `docs: ... (#451)`) that GitHub reports is *not* a PR,
  `pipeline release` completes without aborting with "issue discovery failed".
- [ ] The mis-parsed number `#N` is excluded from the shipped-PR set: it produces no row
  in the scaffolded Shipped section and is never sent to closing-issue resolution.
- [ ] A warning naming the excluded `#N` (skipped because it is not a pull request) is
  emitted.
- [ ] A genuine GitHub API failure (network / auth / rate-limit) on a real PR still
  aborts issue discovery — the existing safety net is not weakened.
- [ ] Numbers parsed from `Merge pull request #N` subjects are trusted as PRs without
  the non-PR exclusion applying to them.
- [ ] A regression test reproduces the docs-style single-`(#N)` non-PR subject in the
  range and fails without the fix (proving it currently aborts).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `release-sub-command`: adds a requirement that shipped-PR discovery tolerate non-PR
  `(#N)` references — excluding them with a warning rather than aborting — while still
  aborting on genuine GitHub API failures.

## Impact

- `core/scripts/stages/release.ts` — `discoverShippedPRs` (candidate PR validation /
  non-PR exclusion) and the `collectShippedIssueNumbers` / abort interaction; the
  `ReleaseDeps` seam used to classify "not a pull request" vs. transient failure.
- `core/test/` — regression test covering a docs-style single-`(#N)` non-PR subject in
  the range.
- Behavior change is confined to `pipeline release`; the non-OpenSpec pipeline path and
  all other stages are unaffected.
