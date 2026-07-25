# product-fault-redaction Specification

## Purpose
TBD - created by archiving change product-fault-reporting. Update Purpose after archive.
## Requirements
### Requirement: The report payload SHALL be assembled from a fixed field allowlist

The engine SHALL construct the product-fault report payload by copying only fields named on a fixed
**allowlist** of bounded diagnostics: Agent Pipeline version, host adapter, stage name, error
class, error `fingerprint`, exit state, and relevant schema versions. Payload construction SHALL be
additive from the allowlist only — a field that is not on the allowlist SHALL NOT appear in the
payload under any circumstance. Free-form strings that could carry identity (raw error messages,
stack frames, command output) SHALL be reduced to the bounded `fingerprint` rather than copied
verbatim. Every allowlisted field SHALL additionally pass through the existing injection screen and
secret redaction before it reaches the wire, as defense in depth.

#### Scenario: only allowlisted fields appear

- **WHEN** the report payload is built from a run's diagnostics
- **THEN** the payload SHALL contain only allowlisted fields (Pipeline version, host adapter, stage,
  error class, fingerprint, exit state, schema versions)
- **AND** any field not on the allowlist SHALL be absent

#### Scenario: raw messages are reduced to a fingerprint

- **WHEN** a run's error carries a raw message, stack frames, or command output
- **THEN** the payload SHALL carry only the derived `fingerprint` and error class
- **AND** SHALL NOT carry the raw message, stack frames, or command output verbatim

### Requirement: Redaction SHALL prove that identifying and secret data cannot enter the payload

The engine SHALL guarantee, with tests that would fail without the guarantee, that the following
categories cannot enter a built payload even when they are present in the classifier's inputs:
repository names/identity, filesystem paths, issue/PR content, prompts and model output, source-code
snippets, environment variable values, and common secret forms (API tokens, private keys, and
`KEY=value` credential pairs). This guarantee SHALL hold when such data appears inside an error
message, a stack frame, or any string that feeds fingerprint computation.

#### Scenario: repository identity and paths cannot enter the payload

- **WHEN** the classifier inputs contain the repository owner/name and absolute filesystem paths
- **THEN** the built payload SHALL contain neither the repository identity nor any path

#### Scenario: issue text, prompts, and source cannot enter the payload

- **WHEN** the classifier inputs contain issue/PR text, a prompt or model output, or a source snippet
- **THEN** none of that content SHALL appear anywhere in the built payload

#### Scenario: environment values and secrets cannot enter the payload

- **WHEN** the classifier inputs contain environment variable values, an API token (e.g. a `ghp_`
  or `AWS_SECRET`-style value), a private key, or a `KEY=value` credential pair
- **THEN** none of those values SHALL appear in the built payload, including when they are embedded
  inside an error message that also feeds the fingerprint

