## ADDED Requirements

### Requirement: The engine SHALL persist a structured per-finding record for every enumerated review finding

The engine SHALL persist, into the run directory, one structured record per finding
enumerated by a review round, so a consumer can render the per-finding Review view without
scraping GitHub. Each finding record SHALL contain the finding's `key`, `severity`, `title`,
`body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`, `category`, and
`blocking` — the full `ReviewFinding` field set plus the stable `key`. Optional source fields
(`file`, `line_start`, `line_end`, `category`, `blocking`) MAY be absent when the reviewer did
not supply them, exactly as on the in-memory `ReviewFinding`. Finding records SHALL be persisted
inside the existing run-directory artifacts (`events.jsonl` and `summary.json`); the engine
SHALL NOT introduce a new run-directory file for them. Finding `body`, `title`, and
`recommendation` SHALL NOT be truncated, because the consumer renders them in full.

#### Scenario: each finding becomes one persisted record

- **WHEN** a review round produces a `ReviewVerdict` with N enumerated findings
- **THEN** the persisted finding array for that round SHALL contain N records, one per finding
- **AND** each record SHALL contain `key`, `severity`, `title`, `body`, `confidence`, and `recommendation`
- **AND** `file`, `line_start`, `line_end`, `category`, and `blocking` SHALL be present when the finding carries them

#### Scenario: a round with zero findings persists an empty finding array

- **WHEN** a review round produces a verdict with no enumerated findings
- **THEN** the persisted finding array for that round SHALL be empty
- **AND** the round's verdict and per-severity counts SHALL still be recorded

#### Scenario: no new run-directory file is introduced

- **WHEN** finding records are persisted for a run
- **THEN** they SHALL be carried within `events.jsonl` and `summary.json`
- **AND** the run directory SHALL contain no additional well-known file beyond `run.json`, `events.jsonl`, `terminal.log`, and `summary.json`

### Requirement: Each persisted finding record SHALL carry the stable findingKey as its correlation handle

Each persisted finding record SHALL carry a `key` equal to `findingKey(finding)` computed by
the single implementation in `review-policy.ts`. The engine SHALL NOT reimplement finding
identity for persistence. Because the key is the same one used by override matching and
recurrence detection, a consumer SHALL be able to correlate a persisted finding with an
`OverrideRecord` in `overrides[]` (matching `key`) and with the same finding persisted in a
different round (matching `key`).

#### Scenario: persisted key equals findingKey

- **WHEN** a finding is persisted into a run-directory record
- **THEN** its `key` SHALL equal `findingKey(finding)` from `review-policy.ts`
- **AND** the engine SHALL NOT compute the key by any other algorithm

#### Scenario: finding correlates with its override

- **WHEN** an operator `--override` was applied to a finding and that finding is persisted
- **THEN** the persisted finding's `key` SHALL equal the `key` of the matching `OverrideRecord` in `overrides[]`

#### Scenario: same finding across two rounds shares a key

- **WHEN** the same underlying finding is enumerated in two review rounds at the same severity, file, and line band
- **THEN** the persisted record in each round SHALL carry the same `key`

### Requirement: Per-finding resolution status SHALL be derivable from the persisted round findings

The persisted per-round finding records SHALL carry sufficient information to derive each
finding's resolution status (resolved / still-open) across fix rounds without scraping GitHub.
Each finding record SHALL carry an `effective_blocking` boolean, computed after
`partitionFindings` runs, that is `true` when the finding landed in `partition.blocking` and
`false` when advisory or overridden. Each finding record SHALL also carry a `payload_fingerprint`
string (equal to `findingPayloadFingerprint(finding)`) that disambiguates distinct findings
that share the same `findingKey` within a round. A consumer SHALL derive resolution by comparing
the `key`+`payload_fingerprint` sets for `effective_blocking=true` records between consecutive
review rounds: a pair absent from a later round is **resolved**; a pair still present is
**still-open**. The engine SHALL NOT store a mutable per-finding status field, because the
per-round records are append-only and resolution is a function of them.

#### Scenario: dropped key is resolved

- **WHEN** a finding `key` has `effective_blocking=true` in round N and no record with that `key` appears in round N+1
- **THEN** a consumer SHALL classify that finding as resolved

#### Scenario: persisted key is still-open

- **WHEN** a finding `key` has `effective_blocking=true` in round N and a record with that `key` also appears in round N+1
- **THEN** a consumer SHALL classify that finding as still-open

#### Scenario: advisory finding has effective_blocking false

- **WHEN** a finding is classified advisory (below the policy block_threshold or below min_confidence) by partitionFindings
- **THEN** its persisted `effective_blocking` SHALL be `false`
- **AND** a consumer filtering by `effective_blocking=true` SHALL correctly exclude it from the blocking resolution set

#### Scenario: same-key distinct findings are disambiguated by payload_fingerprint

- **WHEN** two findings in a round share the same `findingKey` (same file+severity+line-bucket) but differ in body, title, or recommendation
- **THEN** their persisted `payload_fingerprint` values SHALL differ
- **AND** a consumer SHALL use `key`+`payload_fingerprint` pairs to identify which individual finding was resolved across rounds

#### Scenario: derivation needs no network

- **WHEN** a consumer derives resolution from the run directory
- **THEN** it SHALL require only `events.jsonl` and/or `summary.json` and SHALL NOT require any GitHub access

### Requirement: Each persisted review round SHALL record the reviewer harness and model identity

Each persisted review round SHALL record the identity of the reviewer that produced it: the
harness that **actually** reviewed (the effective reviewer, which differs from the configured
reviewer on the same-harness fallback), the reviewer model, and whether the round was a
self-review. This lets the consumer display "reviewed by `<harness>` / `<model>`" and flag a
self-review round honestly.

#### Scenario: round records the effective reviewer harness and model

- **WHEN** a review round completes
- **THEN** the persisted round SHALL record the harness that actually reviewed and the reviewer model

#### Scenario: same-harness fallback is recorded as a self-review

- **WHEN** the configured cross-harness reviewer is unavailable and the implementing harness reviews instead
- **THEN** the persisted round SHALL record the implementing harness as the reviewer and SHALL mark the round as a self-review

### Requirement: Persisted finding records SHALL pass the write-time injection denylist and secret redaction

Persisted finding records SHALL pass through the same write-time injection denylist and
secret-value redaction defined in `run-artifact-conventions` before they are written, because
`title`, `body`, and `recommendation` are reviewer/model-authored free text. A span matching
the injection denylist SHALL be replaced with `[REDACTED-INJECTION]`; a value matching the
secret pattern SHALL be replaced with `[REDACTED]`. Screening SHALL be applied field-level
before serialization so JSON escaping cannot let a secret or role-marker survive. The record
SHALL still be written (with substitutions), not dropped.

#### Scenario: injected content in a finding body is redacted

- **WHEN** a finding `body` contains a span matching an injection-denylist pattern
- **THEN** the persisted record SHALL contain `[REDACTED-INJECTION]` in place of that span
- **AND** the finding record SHALL still be written

#### Scenario: secret in a finding field is redacted before serialization

- **WHEN** a finding field contains a quoted env-secret assignment like `OPENAI_API_KEY="<value>"`
- **THEN** the persisted record SHALL contain `[REDACTED]` in place of the value
- **AND** the raw secret value SHALL NOT appear even though JSON escaping surrounds the quotes

### Requirement: Persisting finding records SHALL be a non-fatal, supplement-only write

Persisting finding records SHALL satisfy the non-fatal I/O and supplement-only contracts: a
write failure SHALL be caught and logged as a warning and SHALL NOT abort, block, or change the
outcome of the review stage. No pipeline label-transition, blocking, or routing decision SHALL
read the persisted finding records; GitHub labels and comments SHALL remain the authoritative
state. All added fields SHALL be optional, so `schema_version` SHALL remain `1`.

#### Scenario: write failure does not affect the review stage

- **WHEN** writing the enriched review record throws an I/O error
- **THEN** the review stage SHALL continue and reach its normal outcome
- **AND** a warning SHALL be logged

#### Scenario: additive fields do not bump schema_version

- **WHEN** the `findings` array and reviewer-identity fields are added to the review record
- **THEN** `schema_version` SHALL remain `1`
- **AND** a consumer that ignores the new fields SHALL behave as before

#### Scenario: records are write-only

- **WHEN** the persisted finding records are deleted or corrupted
- **THEN** the pipeline SHALL continue to make label and routing decisions exactly as before
