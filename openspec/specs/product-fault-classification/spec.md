# product-fault-classification Specification

## Purpose
TBD - created by archiving change product-fault-reporting. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL define a versioned `product_fault` run event distinct from all other evidence classes

The engine SHALL define a `product_fault` member of the run event union, written through the same
`appendEvent` path as every other run event so it is appended to `events.jsonl`, screened by the
write-time injection denylist, secret-redacted, and delivered to any configured external event sink
on identical terms to `papercut` and `correction_event`. The event SHALL carry `schema_version`, a
`payload_schema_version` for the bounded diagnostic payload, an ISO-8601 UTC `at`, the classifier
`confidence` (`low` | `medium` | `high`), an explicit human-readable `rationale` string, and a stable
bounded `fingerprint`. Adding this event type SHALL NOT change the `schema_version` of any existing
event. A `product_fault` event SHALL be recorded only for a *probable Agent Pipeline defect* and
SHALL be classified separately from `correction_event`, `papercut`, target-repository test/build
failures, and host-environment or authentication failures.

#### Scenario: product_fault carries the versioned shape

- **WHEN** the classifier decides a run exhibits a probable Agent Pipeline defect
- **THEN** a `product_fault` event SHALL be appended with `schema_version`, `payload_schema_version`,
  `at`, `confidence`, a non-empty `rationale`, and a `fingerprint`
- **AND** the `schema_version` of every other event type SHALL be unchanged

#### Scenario: product_fault flows through the shared event path

- **WHEN** a `product_fault` event is appended and an external event sink is active
- **THEN** the sink SHALL receive the same JSON line written to `events.jsonl`, already screened by
  the injection denylist and secret redaction, on identical terms to `papercut` and `correction_event`

#### Scenario: target-repo and environment failures are not product faults

- **WHEN** a run fails because the target repository's tests fail, a dependency is missing, auth is
  expired, or the host environment is misconfigured
- **THEN** the classifier SHALL NOT record a `product_fault` event for that failure
- **AND** the existing evidence (target-repo failure, environment/auth failure) SHALL be recorded on
  its own separate terms

#### Scenario: operator corrections are not product faults

- **WHEN** an operator overrides or corrects a Pipeline decision (a `correction_event`)
- **THEN** no `product_fault` event SHALL be derived from that correction

### Requirement: The `product_fault` fingerprint SHALL be stable, bounded, and identity-free

The engine SHALL derive the `product_fault` `fingerprint` from a normalized error signature —
error class plus a path-stripped, token-stripped, digit-normalized message shape — combined with the
Pipeline version, host adapter, and stage. The fingerprint SHALL be a fixed-length hash truncation
(reusing the stable-finding-identity technique) so that two occurrences of the same defect across
different installations produce the same fingerprint, and so that the fingerprint itself contains no
repository identity, filesystem path, secret, or free-form text.

#### Scenario: same defect across installations shares a fingerprint

- **WHEN** the same Agent Pipeline defect (same error class, same normalized message shape, same
  stage, same Pipeline version and host adapter) occurs in two different repositories
- **THEN** the computed `fingerprint` SHALL be identical for both

#### Scenario: fingerprint carries no identifying substrings

- **WHEN** the normalized error signature is derived from a message that contained an absolute path,
  a repository name, or a secret-like token
- **THEN** the resulting `fingerprint` SHALL be a fixed-length hash truncation that contains none of
  those substrings

### Requirement: A non-zero command exit alone SHALL NOT be classified as a product fault

The engine SHALL classify a `product_fault` only when defect-specific signal is present (for
example an internal invariant violation, an engine crash/stack in Pipeline code, or a schema/version
inconsistency in the Pipeline's own artifacts). The mere fact that a spawned command, harness, or
`gh` call exited non-zero SHALL be insufficient on its own; such a signal SHALL be classified `low`
and SHALL NOT emit a `product_fault` event. Low-confidence classifications SHALL remain local and
SHALL require explicit operator action to become a report.

#### Scenario: bare non-zero exit produces no product_fault

- **WHEN** a spawned command exits non-zero but no Agent-Pipeline defect signal is present
- **THEN** the classifier SHALL assign `low` confidence
- **AND** no `product_fault` event SHALL be emitted

#### Scenario: low-confidence stays local

- **WHEN** the classifier assigns `low` confidence to a possible fault
- **THEN** the classification SHALL remain local
- **AND** it SHALL NOT be submitted or promoted without explicit operator action

