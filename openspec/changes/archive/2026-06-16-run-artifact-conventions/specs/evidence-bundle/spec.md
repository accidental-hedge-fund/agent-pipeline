## ADDED Requirements

### Requirement: Evidence bundle carries a schema_version field
The evidence bundle JSON object SHALL include a top-level `schema_version` integer
field. The initial value SHALL be `1`. This aligns the bundle with the cross-cutting
`run-artifact-conventions` spec. The existing `schemaVersion` field (camelCase) is
an alias; both SHALL be treated as equivalent during a transitional period and
documented as such in the README.

#### Scenario: bundle created with schema_version present
- **WHEN** `createBundle()` writes the initial evidence bundle JSON
- **THEN** the resulting object SHALL contain `"schema_version": 1`

#### Scenario: existing schemaVersion field is not removed
- **WHEN** the bundle is read by a consumer that only knows the old `schemaVersion` field name
- **THEN** the consumer SHALL still find `"schemaVersion": 1` (both fields co-exist during the transitional period)

---

### Requirement: Evidence bundle writes are non-fatal
Evidence bundle writes SHALL satisfy the non-fatal I/O contract defined in the
`run-artifact-conventions` spec: errors from creation, stage recording, or
finalization are caught, logged as warnings, and do not propagate to the calling stage.

#### Scenario: bundle write error does not fail the stage
- **WHEN** writing to the evidence bundle file throws an error (e.g., stateDir not writable)
- **THEN** the stage that triggered the write SHALL continue and complete normally
- **AND** a warning SHALL be logged with the error detail

---

### Requirement: Evidence bundle records pass the write-time injection denylist
Evidence bundle records SHALL pass through the write-time injection denylist defined
in `run-artifact-conventions` before being appended. Matching content SHALL be replaced
with `[REDACTED-INJECTION]`; the record SHALL be written with the substitution in place.

#### Scenario: injected content in a CommandRecord output is redacted
- **WHEN** a command's stdout contains a string matching an injection denylist pattern
- **THEN** the matching span in `outputExcerpt` SHALL be replaced with `[REDACTED-INJECTION]`
- **AND** the CommandRecord SHALL still be appended to the bundle

#### Scenario: clean records are unaffected
- **WHEN** no field in a bundle record matches any injection pattern
- **THEN** the record SHALL be written without modification
