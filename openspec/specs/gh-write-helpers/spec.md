# gh-write-helpers Specification

## Purpose
TBD - created by archiving change gh-wrapper-review-followup. Update Purpose after archive.
## Requirements
### Requirement: createIssue helper uses shared ghRun transport

The `gh.ts` module SHALL export a `createIssue(cfg, title, body, labels)` async function that invokes `gh issue create` via `ghRun`, inheriting `ghRun`'s default 30 s timeout and three-attempt exponential-backoff rate-limit retry. The function SHALL parse the issue URL returned by `gh` to extract the integer issue number and return it. On a non-zero exit, it SHALL throw an `Error` whose message includes the `gh` stderr output.

#### Scenario: Successful issue creation returns the issue number

- **WHEN** `createIssue` is called with a valid title, body, and label list
- **THEN** `gh issue create` SHALL be invoked with `--title`, `--body`, `-R <repo>`, and one `--label` argument per label
- **AND** the integer issue number SHALL be extracted from the returned URL and returned as `Promise<number>`

#### Scenario: Non-zero gh exit throws a descriptive error

- **WHEN** `gh issue create` exits with a non-zero status
- **THEN** `createIssue` SHALL throw an `Error` containing the `gh` stderr text

#### Scenario: Timeout surfaces as an error rather than a hang

- **WHEN** the underlying `ghRun` call times out (e.g. ETIMEDOUT)
- **THEN** `createIssue` SHALL propagate the timeout error to the caller within the configured timeout window rather than blocking indefinitely

### Requirement: addIssueComment helper uses shared ghRun transport

The `gh.ts` module SHALL export an `addIssueComment(cfg, issueNumber, body)` async function that invokes `gh issue comment` via `ghRun`, inheriting the same timeout and retry behavior. On a non-zero exit, it SHALL throw an `Error` whose message includes the `gh` stderr output.

#### Scenario: Successful comment post completes without error

- **WHEN** `addIssueComment` is called with a valid issue number and body
- **THEN** `gh issue comment <number> --body <body> -R <repo>` SHALL be invoked and the function SHALL resolve with `void`

#### Scenario: Non-zero gh exit throws a descriptive error

- **WHEN** `gh issue comment` exits with a non-zero status
- **THEN** `addIssueComment` SHALL throw an `Error` containing the `gh` stderr text
