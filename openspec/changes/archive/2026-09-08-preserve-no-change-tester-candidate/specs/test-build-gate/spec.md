## ADDED Requirements

### Requirement: Successful no-change test-fix retry SHALL preserve the current candidate

When the initial test command fails, the fix harness exits successfully without creating a commit or leaving product-relevant changes, and the subsequent test command exits zero, the test/build gate SHALL accept the retry as a no-change success. The gate SHALL preserve the candidate that existed before the fix attempt and SHALL NOT require, create, or imply an empty candidate commit. This exception applies only to the clean no-change outcome; a retry that changes candidate content SHALL continue through the existing candidate-changing verification and publication contract.

#### Scenario: Clean no-change retry passes on the preserved candidate

- **WHEN** the initial test command fails for candidate `C`
- **AND** the fix harness exits successfully with HEAD still at `C` and no product-relevant uncommitted changes
- **AND** the retried test command exits zero
- **THEN** the gate SHALL report a successful retry for candidate `C`
- **AND** SHALL NOT require or manufacture a new commit

#### Scenario: No-change harness success does not hide a repeated test failure

- **WHEN** the fix harness exits successfully without changing candidate `C`
- **AND** the retried test command still exits non-zero
- **THEN** the attempt SHALL NOT be accepted as a successful no-change retry
- **AND** the bounded test-fix loop SHALL retain its ordinary failure and exhaustion behavior

#### Scenario: Product changes retain the candidate-changing path

- **WHEN** a test-fix attempt changes product files or advances HEAD from candidate `C`
- **THEN** the no-change exception SHALL NOT apply
- **AND** the attempt SHALL satisfy the existing commit, build-artifact, traceability, test, publication, review, and exact-head requirements before the new candidate can advance

#### Scenario: Dirty no-commit retry remains untrusted

- **WHEN** the fix harness exits without a new commit
- **AND** product-relevant uncommitted changes remain after the existing salvage opportunity
- **THEN** the gate SHALL block the attempt as untrusted
- **AND** SHALL NOT classify it as a successful no-change retry
