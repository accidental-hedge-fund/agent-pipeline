## ADDED Requirements

### Requirement: PR resolution uses branch prefix and closing references only
`getPrForIssue` SHALL resolve the PR for an issue using exactly two strategies, in order:
1. Head branch starts with `pipeline/<N>-` (branch-prefix match).
2. PR's `closingIssuesReferences` contains the issue number (authoritative closing link).

It SHALL return `null` when neither strategy matches. It SHALL NOT use body-text search, title search, or keyword patterns (`Closes #N`, `Fixes #N`, `#N`, etc.) to match a PR.

#### Scenario: branch-prefix match returns the correct PR
- **WHEN** an open PR has head branch `pipeline/42-my-feature`
- **AND** `getPrForIssue` is called for issue #42
- **THEN** it SHALL return that PR's number without fetching `closingIssuesReferences`

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
