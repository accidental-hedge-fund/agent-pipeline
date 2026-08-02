# gh-transient-retry Specification

## Purpose
TBD - created by archiving change gh-transient-retry. Update Purpose after archive.
## Requirements
### Requirement: ghRun SHALL retry transient gh API failures with exponential backoff

`ghRun` SHALL classify each caught error as either transient or deterministic by calling the `isTransientGhError` function (or the `opts.isTransient` override when provided). When an error is transient AND at least one retry attempt remains, `ghRun` SHALL wait for an exponential backoff delay (using `opts.sleep` when provided, otherwise `setTimeout`) and retry the `gh` subprocess. When the retry budget is exhausted, `ghRun` SHALL throw the last captured error. When an error is deterministic, `ghRun` SHALL throw immediately without consuming any retry attempts.

#### Scenario: transient 401 fails once then succeeds
- **WHEN** a fake `gh` runner returns a stderr containing `"HTTP 401: Bad credentials"` on the first attempt and succeeds on the second
- **THEN** `ghRun` SHALL return the successful stdout without throwing
- **AND** exactly two subprocess invocations SHALL occur

#### Scenario: deterministic 404 is not retried
- **WHEN** a fake `gh` runner always returns a stderr containing `"HTTP 404: Not Found"`
- **THEN** `ghRun` SHALL throw after exactly one attempt
- **AND** no backoff sleep SHALL be invoked

#### Scenario: transient error exhausts the retry budget
- **WHEN** a fake `gh` runner always returns a transient 5xx stderr and `GhRunOptions.retries` is 2
- **THEN** `ghRun` SHALL throw after exactly 2 attempts
- **AND** the error thrown SHALL contain the last captured stderr message

#### Scenario: sleep injection controls backoff timing
- **WHEN** `GhRunOptions.sleep` is provided as a spy function and a transient error triggers a retry
- **THEN** `ghRun` SHALL call `opts.sleep` with the computed backoff duration rather than the real `setTimeout`
- **AND** the spy SHALL be called exactly once per backoff interval between attempts

---

### Requirement: isTransientGhError SHALL classify gh error strings as transient or deterministic

The exported `isTransientGhError(stderr: string): boolean` pure function SHALL return `true` for error strings that indicate a failure class worth retrying and `false` for deterministic failures. The function SHALL inspect the combined stderr and message string case-insensitively.

Transient classes (return `true`):
- HTTP 401 with "bad credentials" in the message (momentary API blip)
- HTTP 403 with "rate limit" or "secondary rate limit" in the message
- Any HTTP 5xx status code (500, 502, 503, 504) in the message
- Network-level errors: ETIMEDOUT, ECONNRESET, ENOTFOUND, socket hang up

Deterministic classes (return `false`):
- HTTP 404 / "not found"
- HTTP 422 / "unprocessable" / "validation failed"
- "repository not found" / "resource not accessible"
- Any error not matched by a transient pattern

#### Scenario: 401 Bad credentials is transient
- **WHEN** `isTransientGhError("HTTP 401: Bad credentials (https://api.github.com/graphql)")` is called
- **THEN** it SHALL return `true`

#### Scenario: rate-limit 403 is transient
- **WHEN** `isTransientGhError("HTTP 403: rate limit exceeded")` is called
- **THEN** it SHALL return `true`

#### Scenario: 502 server error is transient
- **WHEN** `isTransientGhError("HTTP 502: Bad Gateway")` is called
- **THEN** it SHALL return `true`

#### Scenario: ETIMEDOUT network error is transient
- **WHEN** `isTransientGhError("ETIMEDOUT")` is called
- **THEN** it SHALL return `true`

#### Scenario: 404 not found is deterministic
- **WHEN** `isTransientGhError("HTTP 404: Not Found")` is called
- **THEN** it SHALL return `false`

#### Scenario: 422 validation error is deterministic
- **WHEN** `isTransientGhError("HTTP 422: Validation Failed")` is called
- **THEN** it SHALL return `false`

#### Scenario: unknown error pattern is deterministic
- **WHEN** `isTransientGhError("gh: some unrecognized error")` is called
- **THEN** it SHALL return `false`

---

### Requirement: GhRunOptions SHALL accept injectable sleep and isTransient seams

`GhRunOptions` SHALL expose two optional fields for dependency injection in tests:
- `sleep?: (ms: number) => Promise<void>` — used in place of `setTimeout`-based delay during backoff
- `isTransient?: (stderr: string) => boolean` — used in place of `isTransientGhError` to classify errors

When these fields are absent, `ghRun` SHALL use `isTransientGhError` and real `setTimeout` as defaults. The seams SHALL NOT change the default observable behavior of any production code path.

#### Scenario: isTransient override replaces default classification
- **WHEN** `GhRunOptions.isTransient` is provided as a function that always returns `true` and a fake runner always errors
- **THEN** `ghRun` SHALL retry up to `retries` times regardless of the stderr content
- **AND** the default `isTransientGhError` function SHALL NOT be called

#### Scenario: default behavior preserved without seams
- **WHEN** `ghRun` is called with no `sleep` or `isTransient` fields in `GhRunOptions`
- **THEN** `ghRun` SHALL behave identically to the pre-change version for all non-transient error cases
- **AND** the only observable change SHALL be that transient 401, 5xx, and network errors are now retried

### Requirement: Transient-retryable gh mutation and read sites SHALL share bounded retry classification

Transient-retryable gh mutation and read sites SHALL share bounded retry classification through
`ghRun` (or an equivalent wrapper that reuses `isTransientGhError` and exponential backoff).
Production sites dispositioned `transient-retryable` — including label add/remove/edit paths and
other non-attestation reads/mutations that currently fail closed on the first transport error —
SHALL use that wrapper. A transient HTTP 5xx, rate-limit, or network blip SHALL retry within the
configured budget. After success, the caller SHALL continue without parking the issue as a
product block. After exhaustion, the caller SHALL escalate with a canonical infrastructure /
engine-owned reason, not product judgment.

Attestation-grade identity sites dispositioned `deliberately-fail-closed` SHALL remain outside
this automatic retry wrapper requirement (they MAY still use `ghRun` defaults but MUST NOT treat
a missing actor as a soft success).

#### Scenario: Label edit 504 retries and does not product-park on success

- **WHEN** a label mutation invoked through the transient wrapper fails once with stderr
  containing HTTP 504 and succeeds on the next attempt within budget
- **THEN** the wrapper SHALL return success after retry
- **AND** the caller SHALL NOT set a product `needs-human` block solely for the transient blip

#### Scenario: Label edit 504 exhaustion stays typed engine-owned

- **WHEN** a label mutation exhausts retries on repeated HTTP 5xx
- **THEN** the escalation SHALL classify as transient infrastructure / engine-owned
- **AND** SHALL NOT be recorded as a product-judgment human hold solely from that exhaustion

#### Scenario: Deterministic 422 is not retried

- **WHEN** a gh mutation fails with HTTP 422 validation failed
- **THEN** the wrapper SHALL throw or return failure after exactly one attempt
- **AND** no backoff sleep SHALL be invoked for that deterministic class

#### Scenario: Deliberately-fail-closed actor attestation is unchanged

- **WHEN** an attestation site calls `getGhActor` and receives null
- **THEN** the site SHALL fail closed per its integrity disposition
- **AND** SHALL NOT invent a successful actor identity via retry soft-success
)

