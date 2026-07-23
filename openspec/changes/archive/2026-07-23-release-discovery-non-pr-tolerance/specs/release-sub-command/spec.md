## ADDED Requirements

### Requirement: Shipped-PR discovery SHALL tolerate non-PR `(#N)` references

The `release` sub-command SHALL, when enriching a candidate PR number parsed from a
commit subject in the release range, treat a candidate that GitHub reports is **not a
pull request** as a false-positive parse (an issue reference on a non-PR commit): it
SHALL exclude that number from the shipped-PR set, SHALL emit a warning naming the
excluded number, and SHALL NOT abort the release on that basis. An excluded number SHALL
contribute no row to the scaffolded Shipped section and SHALL NOT be sent to
closing-issue resolution. This tolerance exists because a squash-merge commit and a
non-PR commit can both end in a trailing `(#N)` and cannot be told apart syntactically.

A candidate number parsed from an unambiguous `Merge pull request #N` merge-commit
subject SHALL be trusted as a pull request and SHALL NOT be excluded by this rule.

#### Scenario: A docs-style single-`(#N)` non-PR subject does not abort the release

- **WHEN** the release range contains a non-PR commit whose subject ends in a single
  issue reference (e.g. `docs: add v1.21.0 release-plan row to ROADMAP (#451)`) and
  GitHub reports that `#451` is not a pull request ("Could not resolve to a
  PullRequest")
- **THEN** the command SHALL exclude `#451` from the shipped-PR set, SHALL print a
  warning that `#451` was skipped because it is not a pull request, and SHALL continue
  the release without aborting
- **AND** the scaffolded Shipped section SHALL contain no row for `#451`
- **AND** `#451` SHALL NOT be submitted to closing-issue resolution

#### Scenario: A genuine GitHub API failure still aborts issue discovery

- **WHEN** a candidate number that *is* a pull request cannot be resolved because of a
  genuine GitHub API failure (network error, authentication failure, or rate limit)
- **THEN** the command SHALL still treat this as an issue-discovery failure and abort
  with a non-zero exit and a manual-resolution message, rather than silently producing
  an incomplete per-issue ROADMAP stamp

#### Scenario: Merge-commit PR numbers are trusted without exclusion

- **WHEN** a candidate number is parsed from a `Merge pull request #N` merge-commit
  subject
- **THEN** the command SHALL treat `#N` as a pull request and SHALL NOT apply the
  non-PR exclusion rule to it
