## ADDED Requirements

### Requirement: FRG observe-path consumers SHALL map tag-path ineligibility to not-observed without matching formatter copy

Ship FRG observation and any other observe-path consumer of the shared tag validator SHALL treat missing, unreadable, or not-release-eligible `.agent-pipeline/frg/<X.Y.Z>/latest.json` as not observed. They SHALL NOT classify that outcome by matching a substring of the tag-path fail-closed message, including `evidence missing`. They SHALL NOT invent a second release-eligibility definition. Tag-path callers (`release ensure-tag`, `--validate-tag`, and auto-tag when Factory Reliability Gate evidence is not gitignored) SHALL keep fail-closed with the existing remediating message that names `latest.json` and `factory-release prepare` or the Tugboat FRG pack phase.

#### Scenario: Observe mapping does not key off formatter copy

- **WHEN** the shared tag validator fails because `latest.json` is missing, unreadable, or not release-eligible
- **AND** the caller is observing whether a pack has produced release-eligible evidence
- **THEN** the caller SHALL treat the outcome as not observed
- **AND** that classification SHALL remain correct if the tag-path fail-closed message no longer contains `evidence missing`
- **AND** the caller SHALL NOT match `evidence missing` or any other tag-path formatter substring as the only not-observed signal

#### Scenario: Tag path stays fail-closed on the same missing file

- **WHEN** `release ensure-tag` or `--validate-tag` runs for version `1.39.14`
- **AND** `.agent-pipeline/frg/1.39.14/latest.json` is absent or not release-eligible
- **THEN** validation SHALL fail closed
- **AND** the message SHALL name `.agent-pipeline/frg/1.39.14/latest.json`
- **AND** the command SHALL NOT create or push `v1.39.14`

#### Scenario: Observe mapping reuses tag eligibility, not a second checker

- **WHEN** observe-path mapping decides that `latest.json` is not release-eligible
- **THEN** that decision SHALL use the same eligibility rules as the shared tag validator
- **AND** it SHALL NOT accept a `pass: false` or HMAC-invalid artifact as observed evidence
