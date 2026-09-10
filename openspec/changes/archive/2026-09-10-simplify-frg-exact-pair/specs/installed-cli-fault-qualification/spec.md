## ADDED Requirements

### Requirement: Genuine CLI and fault regressions SHALL remain in normal deterministic CI

Removal of installed-CLI qualification from the release path SHALL NOT remove deterministic coverage of ordinary admission, logical-operation accounting, exact-source launcher behavior, process-boundary fault classification, ownership retention, or runtime recovery. Such coverage SHALL run under the normal repository CI gate with injected or closed secret-free seams and SHALL NOT require remote fixture creation, release scoring, or attestation.

#### Scenario: Release qualification machinery is absent but regressions still bite

- **WHEN** a launcher route loses exact-source behavior, a fault becomes false-human or ownerless-terminal, or logical-operation accounting becomes incorrect
- **THEN** a normal deterministic CI test SHALL fail
- **AND** the failure SHALL NOT depend on generating an installed-qualification artifact for release

#### Scenario: Choreography-only tests are retired

- **WHEN** a test's only observable subject is the deleted release qualification, matrix scoring, or attestation choreography
- **THEN** that test SHALL be removed rather than preserved as a requirement
- **AND** user-visible CLI or recovery assertions from it SHALL be migrated to the normal deterministic suite

### Requirement: Exact-candidate inventory assertions SHALL enumerate the trusted candidate

Any remaining qualification or exact-source assertion that compares a materialized exact-HEAD candidate with an expected test or module inventory SHALL derive both sides from that trusted candidate root and commit. It SHALL NOT enumerate live dirty files from the operator working directory. The assertion SHALL remain enforced.

#### Scenario: Dirty operator test does not contaminate exact HEAD

- **WHEN** an uncommitted test file exists under the operator checkout's `core/test`
- **AND** deterministic validation materializes and checks the exact current HEAD candidate
- **THEN** the uncommitted file SHALL NOT appear in the candidate's expected inventory
- **AND** normal `npm run ci` SHALL NOT fail for an inventory mismatch caused solely by that file

#### Scenario: Candidate inventory defect still fails

- **WHEN** the trusted candidate itself omits or adds an inventory item inconsistently with the asserted contract
- **THEN** the inventory assertion SHALL fail
- **AND** the checker SHALL NOT skip or weaken the assertion to avoid the failure

## REMOVED Requirements

### Requirement: Qualification SHALL execute the staged installed launcher

**Reason**: A release-specific installed-launcher qualification pass is no longer a prerequisite for creating the exact-pair fixtures.

**Migration**: Retain each genuine public-route regression as a normal deterministic CLI test and retire artifact-only choreography.

### Requirement: Qualification SHALL inject and observe faults at the process boundary

**Reason**: The release matrix and qualification artifact are removed; the underlying fault ownership behavior remains product behavior.

**Migration**: Exercise process-boundary and durable-state faults in normal deterministic CI with parent-observed outcomes.

### Requirement: Qualification evidence SHALL be exact-candidate bound and tamper evident

**Reason**: The exact-candidate FRG result directly binds candidate and authoritative fixture evidence without qualification rows or a release matrix.

**Migration**: Use the exact-candidate FRG result for release proof and candidate-root inventory semantics for any retained qualification utility.
