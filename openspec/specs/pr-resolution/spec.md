# pr-resolution Specification

## Purpose
Authoritative issue→PR resolution shared by every pipeline stage: `getPrForIssue` maps an issue to the open PR that actually belongs to it — via pipeline branch naming or GitHub closing references — never via body-text mention.

## Requirements

### Requirement: PR resolution uses branch prefix and closing references only
`getPrForIssue` SHALL resolve the PR for an issue using exactly two strategies, in order:
1. Head branch starts with `pipeline/<N>-` (branch-prefix match) AND the PR is not from a fork — a fork PR's head branch name can spoof the prefix.
2. PR's `closingIssuesReferences` contains the issue in the target repo (authoritative closing link). References targeting a different repository SHALL be ignored; the owner/repo comparison SHALL be case-insensitive.

It SHALL return `null` when neither strategy matches. It SHALL NOT use body-text search, title search, or keyword patterns (`Closes #N`, `Fixes #N`, `#N`, etc.) to match a PR.

Resolution SHALL be served from a complete open-PR candidate set that carries the branch name, fork flag, and closing references of every open candidate needed for those strategies — no per-PR `gh pr view` fan-out. The candidate set SHALL NOT be a fixed first-page-only / hard `-L 100` (or equivalent) truncation of the repository's open PRs; when the open list does not fit a single page, the resolver SHALL paginate (or use an issue-scoped / head-query equivalent that cannot omit a matching open PR solely for list-window reasons).

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

### Requirement: Open PR resolution SHALL NOT silently truncate the open candidate set
`getPrForIssue` SHALL NOT resolve against a silently truncated open-PR list. When more open PRs exist than fit a single list page or a fixed 100-item window, the open path SHALL continue enumerating (paginate, issue-scoped GraphQL equivalent, or a complete head/`pipeline/<N>-*` query path that still applies dual-strategy resolution) until either a matching open PR is found under the living dual strategies or open candidates are exhausted. Returning `null` solely because the matching open PR fell outside the first page or first 100 open PRs of a repo-wide scan is forbidden. Unit tests SHALL cover the beyond-first-page / beyond-100-window case via injected list or API deps (no real network).

#### Scenario: matching open PR beyond the first 100 open PRs is still resolved
- **WHEN** the repository has more than 100 open PRs
- **AND** the only PR that matches issue N (branch-prefix or target-repo closing reference) would not appear in a single `gh pr list --state open -L 100` window
- **AND** `getPrForIssue` is called for issue N
- **THEN** it SHALL return that PR's number
- **AND** SHALL NOT return `null` due to the open-list window alone

#### Scenario: multi-page open enumeration is exercised under test
- **WHEN** unit tests inject a multi-page open-PR list (or equivalent multi-call API runner) where the match appears only on a later page
- **THEN** `getPrForIssue` SHALL return the matching PR number
- **AND** the test setup SHALL fail if the production open path stops after one capped page without consulting later pages

#### Scenario: exhausted open candidates with no match still return null
- **WHEN** complete open enumeration finds no branch-prefix or target-repo closing-reference match for the issue
- **THEN** `getPrForIssue` SHALL return `null`

### Requirement: Any-state PR resolution SHALL accept merged pipeline mentions

Any-state issue-to-PR resolution SHALL treat a same-repo pull request as linked to issue N when the issue timeline records any of:

1. a `ConnectedEvent` whose subject is that pull request, or
2. a `CrossReferencedEvent` with `willCloseTarget: true` whose source is that pull request, or
3. a `CrossReferencedEvent` whose source is a same-repo pull request whose head ref starts with `pipeline/<N>-`, or
4. a `CrossReferencedEvent` whose source is a same-repo pull request whose title contains the parenthetical `(#N)`.

It SHALL ignore fork pull requests (`isCrossRepository: true`) under every identity. It SHALL NOT treat a non-pipeline mention (`willCloseTarget: false`, head not `pipeline/<N>-*`, title without `(#N)`) as a link. It SHALL keep scanning newest-first and SHALL return the newest matching same-repo pull request. Open-PR resolution SHALL remain branch-prefix plus `closingIssuesReferences` only and SHALL NOT search titles or body text.

#### Scenario: Non-closing pipeline-head CrossReferencedEvent resolves

- **WHEN** the issue timeline has a `CrossReferencedEvent` with `willCloseTarget: false`
- **AND** the source pull request is same-repo with head `pipeline/1258-resume-after-run-fatal`
- **AND** any-state resolution runs for issue 1258
- **THEN** it SHALL return that pull request's number
- **AND** it SHALL NOT return null solely because `willCloseTarget` is false

#### Scenario: Non-closing parenthetical title CrossReferencedEvent resolves

- **WHEN** the issue timeline has a `CrossReferencedEvent` with `willCloseTarget: false`
- **AND** the source pull request is same-repo with title containing `(#1258)`
- **AND** the head ref is not `pipeline/1258-*`
- **AND** any-state resolution runs for issue 1258
- **THEN** it SHALL return that pull request's number

#### Scenario: ConnectedEvent and closing CrossReferencedEvent still resolve

- **WHEN** the issue timeline has a `ConnectedEvent` to a same-repo pull request
- **OR** a `CrossReferencedEvent` with `willCloseTarget: true` to a same-repo pull request
- **THEN** any-state resolution SHALL return that pull request's number

#### Scenario: Mere non-pipeline mention does not resolve

- **WHEN** the issue timeline has only a `CrossReferencedEvent` with `willCloseTarget: false`
- **AND** the source pull request head is not `pipeline/<N>-*`
- **AND** the source pull request title does not contain `(#N)`
- **THEN** any-state resolution for issue N SHALL return null

#### Scenario: Fork PR cannot spoof any-state pipeline identity

- **WHEN** a `CrossReferencedEvent` or `ConnectedEvent` points at a pull request with `isCrossRepository: true`
- **AND** that pull request head is `pipeline/1258-spoofed` or its title contains `(#1258)`
- **THEN** any-state resolution for issue 1258 SHALL NOT return that pull request

#### Scenario: Open-PR resolution does not gain title search

- **WHEN** an open pull request title contains `(#42)` or `Fixes #42`
- **AND** its head is not `pipeline/42-*`
- **AND** its `closingIssuesReferences` does not include issue 42
- **THEN** open-PR resolution for issue 42 SHALL return null
