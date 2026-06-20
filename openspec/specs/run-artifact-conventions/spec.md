# run-artifact-conventions Specification

## Purpose
TBD - created by archiving change run-artifact-conventions. Update Purpose after archive.
## Requirements
### Requirement: All artifact writes are non-fatal
Every code path that writes or serializes a machine-readable run artifact SHALL wrap
its I/O in a try/catch. On failure, the engine SHALL log a warning (including the
error and stack) and return without propagating the error. A failed artifact write
SHALL NOT abort, block, or affect the outcome of the pipeline stage it is observing.

#### Scenario: write failure does not abort the stage
- **WHEN** writing a run artifact throws an I/O error (e.g., disk full, permission denied)
- **THEN** the stage SHALL continue to completion
- **AND** a warning message SHALL be logged containing the error description
- **AND** the pipeline state machine SHALL not transition to an error state due solely to the artifact write failure

#### Scenario: successful writes behave as before
- **WHEN** writing a run artifact succeeds
- **THEN** the artifact SHALL be persisted to disk exactly as before
- **AND** no warning SHALL be logged

---

### Requirement: Write-time injection denylist screens every artifact record
Before persisting any event or record to a machine-readable artifact, the engine SHALL
apply a write-time injection denylist to the serialized content. Any span matching a
denylist pattern SHALL be replaced with the placeholder `[REDACTED-INJECTION]`. The
original field values SHALL NOT be logged. Records with redacted content SHALL be
written as modified; they SHALL NOT be silently dropped. For artifacts produced by
`JSON.stringify`, redaction and injection screening SHALL be applied to the string
fields BEFORE serialization (field-level), so that JSON escaping (e.g. `KEY="x"` →
`KEY=\"x\"`, embedded newlines) cannot let a secret or role-marker survive a
serialized-text-only pass.

#### Scenario: secret in a JSON-serialized artifact field is redacted despite escaping
- **WHEN** a string field of a `JSON.stringify`-serialized artifact (e.g. the doctor preflight result) contains a secret env assignment like `OPENAI_API_KEY="<value>"`
- **THEN** the persisted artifact SHALL contain `[REDACTED]` in place of the value
- **AND** the raw secret value SHALL NOT appear, even though `JSON.stringify` escapes the surrounding quotes

#### Scenario: secret in an evidence-bundle record field is redacted before serialization
- **WHEN** an evidence-bundle record appended through any path (including an operator-supplied `OverrideRecord.reason`, a review summary, or a recovery record) contains a quoted env-secret assignment like `OPENAI_API_KEY="<value>"`
- **THEN** the engine SHALL apply field-level redaction before `JSON.stringify`
- **AND** the persisted `evidence.json` SHALL contain `[REDACTED]` in place of the value
- **AND** the raw secret value SHALL NOT appear, even though `JSON.stringify` escapes the surrounding quotes

#### Scenario: denylist match causes redaction, not rejection
- **WHEN** a field value in a record contains an injection-pattern match (e.g., "ignore previous instructions")
- **THEN** the matching span SHALL be replaced with `[REDACTED-INJECTION]` in the persisted record
- **AND** the record SHALL still be written (not dropped)
- **AND** a debug-level log entry SHALL note that redaction occurred on that record

#### Scenario: clean record is written unmodified
- **WHEN** no field in a record matches any denylist pattern
- **THEN** the record SHALL be written without modification

#### Scenario: multi-line injection is caught
- **WHEN** a string value contains a newline followed by "you are now" (or any other denylist pattern)
- **THEN** the matching span SHALL be replaced with `[REDACTED-INJECTION]`

---

### Requirement: Every machine-readable record carries a schema_version field
Every JSON object or JSONL record written to a machine-readable artifact SHALL include
a top-level `schema_version` integer field. The initial value SHALL be `1`. Consumers
SHALL treat an absent `schema_version` as `0` (pre-convention).

#### Scenario: new record includes schema_version
- **WHEN** the engine writes any machine-readable record (evidence bundle, events.jsonl line, summary.json, doctor --json output)
- **THEN** the serialized JSON SHALL contain `"schema_version": 1` (or higher if a breaking change has occurred)

#### Scenario: backward-compat promise: new optional fields do not bump version
- **WHEN** a new optional field is added to a record type
- **THEN** `schema_version` SHALL remain unchanged
- **AND** existing consumers that ignore unknown fields SHALL continue to function

#### Scenario: breaking change bumps schema_version
- **WHEN** a field is removed or renamed in a record type
- **THEN** `schema_version` SHALL be incremented
- **AND** this SHALL be documented in the changelog before the change ships

---

### Requirement: Local-only fields use a _ prefix and are documented
Machine-readable record fields that SHALL NOT be surfaced to any remote or sync target
(e.g., absolute local paths, workspace-local identifiers) SHALL use a leading underscore
name (e.g., `_localPath`, `_workspacePath`). The README SHALL include a section listing
all current `_`-prefixed fields and documenting the convention.

#### Scenario: local-only field is identifiable by name
- **WHEN** a consumer reads a machine-readable record
- **THEN** any field whose value is local-machine-specific SHALL have a name starting with `_`
- **AND** the README SHALL document each such field name with a description of why it is local-only

#### Scenario: non-local fields do not use _ prefix
- **WHEN** a field is safe to share or sync (e.g., issue number, verdict string, schema_version)
- **THEN** its name SHALL NOT start with `_`

---

### Requirement: Artifacts share data through the filesystem only
The pipeline engine SHALL NOT introduce any event bus, IPC daemon, or in-process event
emitter as a mechanism for sharing data between artifact writers. When one artifact
writer needs data produced by another, the producer SHALL write its output to an
agreed filesystem path and the consumer SHALL read from that path.

#### Scenario: no runtime cross-artifact subscription
- **WHEN** a new artifact writer is added to the engine
- **THEN** it SHALL read its inputs from filesystem paths, not from in-memory event subscriptions or IPC channels

---

### Requirement: Value-redaction extends to all run-dir artifacts
Value-redaction SHALL apply to all machine-readable run-dir artifacts: `events.jsonl`,
`summary.json`, and `doctor --json` output, in addition to the evidence bundle records
already covered by the evidence-bundle spec. Raw token values, env var secrets, and
other sensitive data SHALL be replaced with `[REDACTED]` before any record is written.

#### Scenario: secret in events.jsonl is redacted
- **WHEN** a JSONL event record would contain a raw GitHub token or API key
- **THEN** the value SHALL be replaced with `[REDACTED]` before the line is written

#### Scenario: secret in summary.json is redacted
- **WHEN** the summary JSON would include a field whose value matches the secret pattern
- **THEN** the value SHALL be replaced with `[REDACTED]`

### Requirement: gh_metrics_summary carries schema_version and follows non-fatal write convention
The `gh_metrics_summary` event type SHALL be treated as a machine-readable run artifact record. It SHALL include a top-level `schema_version` integer field (initial value `1`). Its write path SHALL wrap `appendFile` in a try/catch and log a warning on failure, consistent with the non-fatal write convention established for all other run artifact writes.

#### Scenario: gh_metrics_summary record includes schema_version
- **WHEN** the `gh_metrics_summary` event is serialized and appended to `events.jsonl`
- **THEN** the JSON line SHALL contain `"schema_version": 1`

#### Scenario: write failure is non-fatal
- **WHEN** the `appendFile` call for the `gh_metrics_summary` record throws an I/O error
- **THEN** the engine SHALL catch the error, log a warning, and NOT propagate the failure to the caller
- **AND** all subsequent pipeline finalization steps SHALL still execute

