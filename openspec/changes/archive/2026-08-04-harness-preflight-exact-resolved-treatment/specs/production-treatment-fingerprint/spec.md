## ADDED Requirements

### Requirement: Production preflight-on-invoke SHALL own the readiness production of absolute CLI path and once-per-run version probe results consumed by fingerprints

The once-per-run binary/version probe and absolute CLI path resolution used for production treatment fingerprints SHALL be produced or confirmed on the production preflight-on-invoke path (#636) and consumed by fingerprint / stage-accounting emission. Fingerprint construction SHALL NOT introduce a second independent always-on version probe implementation.

When production preflight has resolved an absolute CLI path, the fingerprint’s CLI path field SHALL
prefer that resolved value for the invocation. When the shared version probe has succeeded, the
fingerprint’s `cliVersion` SHALL prefer that cached value. Failures of readiness (missing CLI)
remain preflight-blocking; version **drift** against verified-against remains fail-soft as specified
elsewhere in this capability.

#### Scenario: Fingerprint consumes preflight-produced absolute path

- **WHEN** production preflight resolves an absolute executable path for an adapter CLI and a
  production invocation records a treatment fingerprint
- **THEN** the fingerprint SHALL include that absolute path when known
- **AND** SHALL NOT invent a different path from an independent unchecked lookup solely for
  fingerprinting

#### Scenario: Fingerprint consumes shared once-per-run version probe

- **WHEN** production preflight and fingerprint accounting both need CLI version for the same run
  and CLI identity
- **THEN** both SHALL read the shared cached probe result
- **AND** fingerprint emission SHALL NOT spawn a second always-on per-call version process
