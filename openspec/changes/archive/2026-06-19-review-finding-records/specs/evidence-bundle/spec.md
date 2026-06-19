## MODIFIED Requirements

### Requirement: Bundle records review verdict summaries
After each review round, the bundle SHALL record a `ReviewRecord` containing: `round` (integer, 1-indexed), `sha` (the head commit SHA reviewed), `verdict` (the verdict string from the review schema, e.g. `"approved"` or `"changes_requested"`), and `findingCounts` (an object mapping severity levels to integer counts).

The `ReviewRecord` SHALL additionally carry a `findings` array — one structured record per finding enumerated by the round — and the reviewer identity for the round (`harness`, the harness that actually reviewed; `model`, the reviewer model; and `selfReview`, a boolean). Each finding record SHALL contain `key` (the stable `findingKey` from `review-policy.ts`), `severity`, `title`, `body`, `confidence`, and `recommendation`, and SHALL contain `file`, `line_start`, `line_end`, `category`, and `blocking` when the finding carries them. Each finding record SHALL also carry `effective_blocking` (boolean, computed from `partitionFindings` after the active review policy is applied — `true` when the finding blocks pipeline advancement, `false` when advisory or overridden) and `payload_fingerprint` (`findingPayloadFingerprint(finding)` — disambiguates distinct findings that share the same `findingKey` within a round). These additions are optional fields, so the bundle `schema_version` SHALL remain `1`; finding text fields SHALL be screened by the write-time injection denylist and secret redaction before the bundle is serialized.

#### Scenario: review verdict recorded
- **WHEN** the review stage parses a verdict JSON and calls `recordReview()`
- **THEN** the bundle `reviews` array SHALL contain a `ReviewRecord` with `round`, `sha`, `verdict`, and `findingCounts`

#### Scenario: review record carries per-finding records
- **WHEN** a review round enumerates one or more findings and `recordReview()` is called
- **THEN** the `ReviewRecord` SHALL contain a `findings` array with one record per finding
- **AND** each record SHALL contain `key`, `severity`, `title`, `body`, `confidence`, and `recommendation`
- **AND** the `key` SHALL equal `findingKey(finding)` so it correlates with `overrides[]` and with the same finding in another round

#### Scenario: review record carries reviewer identity
- **WHEN** a review round completes and `recordReview()` is called
- **THEN** the `ReviewRecord` SHALL contain `harness` (the harness that actually reviewed), `model`, and `selfReview`

#### Scenario: review record with zero findings carries an empty array
- **WHEN** a review round produces a verdict with no enumerated findings
- **THEN** the `ReviewRecord` `findings` array SHALL be empty
- **AND** `verdict` and `findingCounts` SHALL still be recorded

#### Scenario: multiple review rounds accumulate
- **WHEN** two review rounds complete
- **THEN** the bundle `reviews` array SHALL contain two entries with `round: 1` and `round: 2` respectively
- **AND** a consumer SHALL be able to derive per-finding resolution by comparing the `key` sets of the two rounds' `findings` arrays
