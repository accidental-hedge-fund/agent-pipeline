## MODIFIED Requirements

### Requirement: Follow-up issue and comment writes use the shared async gh transport
The default implementations for follow-up issue creation (`defaultCreateIssue`) and issue comment posting (`defaultAddIssueComment`) in the review stage SHALL delegate to the `createIssue` and `addIssueComment` helpers exported from `gh.ts`, which are built on `ghRun`. These defaults SHALL NOT call `spawnSync` directly. The `deps.createIssue` and `deps.addIssueComment` injection seam interfaces SHALL remain unchanged so unit tests continue to use fake implementations without modification.

#### Scenario: Follow-up issue creation inherits timeout enforcement
- **WHEN** the ceiling action files a new follow-up issue via the default `createIssue` implementation
- **THEN** the underlying `gh` call SHALL be subject to the `ghRun` timeout (default 30 s) and SHALL throw rather than hang if `gh` does not respond in time

#### Scenario: Follow-up comment posting inherits rate-limit retry
- **WHEN** the ceiling action appends findings to an existing follow-up via the default `addIssueComment` implementation
- **AND** `gh issue comment` returns a rate-limit error on the first attempt
- **THEN** the call SHALL be retried with exponential backoff up to three attempts before failing

#### Scenario: Dep injection seam is unchanged
- **WHEN** a unit test injects a fake `deps.createIssue` or `deps.addIssueComment`
- **THEN** the fake SHALL be called exactly as before — the change to the default implementation SHALL NOT alter the `AdvanceReviewDeps` interface or the call sites that reference it
