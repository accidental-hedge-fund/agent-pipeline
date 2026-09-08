## ADDED Requirements

### Requirement: Decisions publication SHALL compact repeated evidence without semantic loss

When the same evidence value appears in multiple Decisions nodes or authority requests, Pipeline SHALL store that value once in the embedded artifact and SHALL use digest-bound references for repeated occurrences when that representation reduces the complete issue-body size. Parsing SHALL expand those references to the same in-memory evidence values used by valid inline artifacts. Compaction SHALL preserve every node, authority-request field, provenance value, input digest, content/hash binding, and unrelated issue-body section. Existing valid artifacts that inline all evidence SHALL remain readable and SHALL round-trip without semantic loss.

Before attempting an issue-body mutation, Pipeline SHALL measure the complete body it would publish against the supported 65,536-character ceiling. If the complete compact representation still exceeds that ceiling, Pipeline SHALL reject publication explicitly. It SHALL NOT truncate unique evidence, omit a node, weaken an authority field, or attempt a known-impossible write.

#### Scenario: Repeated authority evidence is represented once

- **WHEN** eleven authority nodes each carry the same 25,000-character evidence in both node evidence and authority-request evidence
- **THEN** the complete rendered issue body SHALL contain digest-bound references to one stored copy of the repeated value
- **AND** the body SHALL be no more than 65,536 characters
- **AND** parsing SHALL restore the full evidence value to every original occurrence
- **AND** all node, authority, provenance, digest, and unrelated body fields SHALL equal their pre-render semantics

#### Scenario: Existing inline artifact remains compatible

- **WHEN** Pipeline reads a previously valid Decisions artifact whose repeated evidence is stored inline
- **THEN** the artifact SHALL parse successfully
- **AND** a parse and render round-trip SHALL preserve its decision semantics and integrity bindings

#### Scenario: Unique oversize content is refused before publication

- **WHEN** a complete Decisions body still exceeds 65,536 characters after every beneficial repeated-evidence reference is applied
- **THEN** Pipeline SHALL return an explicit oversize failure before invoking the issue-body writer
- **AND** it SHALL NOT truncate evidence, discard nodes, or mutate the issue
