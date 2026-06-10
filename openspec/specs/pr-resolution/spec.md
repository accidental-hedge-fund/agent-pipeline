# pr-resolution Specification

## Purpose
Authoritative issue→PR resolution shared by every pipeline stage: `getPrForIssue` maps an issue to the open PR that actually belongs to it — via pipeline branch naming or GitHub closing references — never via body-text mention.
## Requirements
### Requirement: PR resolution uses branch prefix and closing references only
`getPrForIssue` SHALL resolve the PR for an issue using exactly two strategies, in order:
1. Head branch starts with `pipeline/<N>-` (branch-prefix match) AND the PR is not from a fork — a fork PR's head branch name can spoof the prefix.
2. PR's `closingIssuesReferences` contains the issue in the target repo (authoritative closing link). References targeting a different repository SHALL be ignored; the owner/repo comparison SHALL be case-insensitive.

It SHALL return `null` when neither strategy matches. It SHALL NOT use body-text search, title search, or keyword patterns (`Closes #N`, `Fixes #N`, `#N`, etc.) to match a PR.

Resolution SHALL be served from a single `gh pr list` query carrying the branch name, fork flag, and closing references of every candidate — no per-PR `gh pr view` fan-out.

#### Scenario: branch-prefix match returns the correct PR
- **WHEN** an open same-repo PR has head branch `pipeline/42-my-feature`
- **AND** `getPrForIssue` is called for issue #42
- **THEN** it SHALL return that PR's number without any per-PR API calls

#### Scenario: fork PR cannot spoof the branch fast path
- **WHEN** an open PR from a fork has head branch `pipeline/42-spoofed`
- **AND** its `closingIssuesReferences` does NOT include issue #42
- **THEN** `getPrForIssue` for issue #42 SHALL NOT return that PR

#### Scenario: cross-repo closing reference is not matched
- **WHEN** an open PR's `closingIssuesReferences` contains issue #42 of a different repository
- **AND** no strategy matches the issue in the target repo
- **THEN** `getPrForIssue` for issue #42 SHALL return `null`

#### Scenario: closing-references match returns the correct PR
- **WHEN** no open PR has a head branch starting with `pipeline/42-`
- **AND** an open PR has `closingIssuesReferences` containing issue #42
- **THEN** `getPrForIssue` SHALL return that PR's number

#### Scenario: unrelated PR mentioning the issue number is not returned
- **WHEN** an open PR's body contains `#42` or `Fixes #42` but its `closingIssuesReferences` does NOT include issue #42
- **AND** its head branch does not start with `pipeline/42-`
- **THEN** `getPrForIssue` for issue #42 SHALL NOT return that PR

#### Scenario: no matching PR returns null
- **WHEN** no open PR has a `pipeline/42-*` head branch
- **AND** no open PR has `closingIssuesReferences` containing issue #42
- **THEN** `getPrForIssue` SHALL return `null`

#### Scenario: all pipeline stages use the same resolver
- **WHEN** `getPrForIssue` is called from any of: status display, planning, review, pre-merge, or deploy-ready
- **THEN** all callers SHALL receive the same authoritative resolution (branch-prefix or closing-references), never a body-text false positive

