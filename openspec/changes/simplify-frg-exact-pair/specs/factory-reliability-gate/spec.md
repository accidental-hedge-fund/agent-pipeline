## ADDED Requirements

### Requirement: Release-path FRG verification SHALL consume the exact-candidate pair result

The release-path FRG verifier SHALL accept only a conforming observer-owned result from the `exact-candidate-frg` capability for the expected candidate epoch and exact candidate SHA. It SHALL NOT require or accept a scenario score, threshold, installed-CLI qualification artifact, HMAC attestation, factory-release prepare request, nested candidate lease transfer, owner-observation handoff, or re-observation state machine as substitute proof. Remaining legacy callers MAY continue to exist only until their dependency-checked retirement package; the new release-path gate SHALL NOT invoke them.

#### Scenario: Exact-pair result satisfies the new verification contract

- **WHEN** a release-path caller verifies a conforming result that proves both intended fixtures for its exact candidate and epoch
- **THEN** verification SHALL accept that single result without prepare, score, attest, or re-observe dependencies

#### Scenario: Legacy release artifact cannot satisfy the new gate

- **WHEN** a caller presents only an old score report, pass boolean, qualification matrix, attestation, pack-loop binding, or public hash
- **THEN** the exact-candidate FRG verification contract SHALL remain unsatisfied

#### Scenario: Remaining caller does not justify parallel machinery

- **WHEN** a legacy caller has not yet been removed by the later retirement package
- **THEN** it SHALL NOT be added as a dependency of the exact-candidate pair path
- **AND** the implementation SHALL NOT maintain two release-eligible FRG state machines

## REMOVED Requirements

### Requirement: Every release version SHALL require a recorded Factory Reliability Gate pass

**Reason**: The scoreboard-shaped version pass is replaced on the release path by the exact-candidate pair result.

**Migration**: Release-path consumers validate the exact candidate and epoch through `exact-candidate-frg`; historical artifacts remain historical records only.

### Requirement: The FRG SHALL exercise a fixed multi-item scenario pack

**Reason**: Release qualification now exercises exactly the retained clean-docs and clean-openspec ordinary issues rather than a scored scenario matrix.

**Migration**: Preserve genuine deterministic fault regressions in normal CI and use the two retained templates for the final live proof.

### Requirement: FRG Layer B live driver SHALL produce machine-readable pass or fail evidence

**Reason**: Its score, threshold, and scenario report shape is replaced by one authoritative runner/observer result.

**Migration**: Consumers read the exact-candidate FRG result schema.

### Requirement: Release-eligible FRG evidence SHALL carry a producer HMAC attestation

**Reason**: Independent authoritative observation replaces a separate attestation system; human or worker attestation cannot manufacture evidence.

**Migration**: Keep observer-owned state outside fixture-worker control and validate each authoritative source directly.

### Requirement: Durable post-pilot FRG generation SHALL create a fresh candidate pack from the exact integrated base

**Reason**: The new gate reconciles one intended exact pair and never creates successor packs for an unchanged epoch.

**Migration**: Use candidate-bound slot provenance and exact-pair reconciliation.

### Requirement: Nested pack-loop launch SHALL hand off the existing candidate lease

**Reason**: The ordinary loop owns fixture lifecycle under existing issue locks; FRG no longer starts a nested release-specific scheduler.

**Migration**: Reuse same-host release exclusion and the ordinary domain-aware issue-run lock.

### Requirement: The immutable ship lease owner SHALL observe its live pack handoff

**Reason**: The release-owned observer directly records ordinary run identities and authoritative state, eliminating the nested owner-observation protocol.

**Migration**: Resume from the compact exact-pair result and ordinary loop records.

### Requirement: Deterministic candidate qualification SHALL precede remote fixture creation

**Reason**: Installed-CLI qualification and matrix proof are no longer release-path prerequisites.

**Migration**: Candidate resolve-and-prepare remains mandatory; genuine launcher and recovery regressions run as ordinary deterministic CI tests.
