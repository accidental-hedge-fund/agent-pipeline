## MODIFIED Requirements

### Requirement: Test-fix loop verifies commit message format

After each test-fix harness invocation within the test gate, the pipeline SHALL verify that at least one commit in `headBefore..HEAD` has a message matching the pattern `fix: resolve test/build failures (#<issue_number>)` (case-insensitive) when the attempt creates a commit or changes candidate content. A harness invocation that leaves HEAD unchanged and leaves no product-relevant uncommitted changes MAY proceed without commit-format verification only long enough to re-run the test command; it is accepted as a no-change success only if that command exits zero. The pipeline SHALL NOT create or require an empty commit for that clean no-change case.

#### Scenario: Test-fix commit message matches prescribed format

- **WHEN** the test-fix harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** at least one commit message matches `fix: resolve test/build failures (#<issue_number>)`
- **THEN** the test gate SHALL proceed to re-run the test command

#### Scenario: Test-fix commit message does not match — attempt is blocked

- **WHEN** the test-fix harness exits 0 and new commits exist on `headBefore..HEAD`
- **AND** no commit message matches the prescribed format
- **THEN** the test gate SHALL treat this attempt as failed (not the same as a test failure — no retry)
- **AND** SHALL block with reason: `"Test-fix commit message does not match prescribed format"`

#### Scenario: Clean no-commit attempt may prove a no-change success

- **WHEN** the test-fix harness exits 0 with HEAD unchanged from `headBefore`
- **AND** no product-relevant uncommitted changes remain
- **THEN** the pipeline SHALL skip commit-message and trailer verification for that attempt
- **AND** SHALL re-run the test command against the unchanged candidate
- **AND** SHALL accept the attempt only if that command exits zero

#### Scenario: Empty commit is not a substitute for no-change proof

- **WHEN** a test-fix retry needs no product-file modification to make the test command pass
- **THEN** the harness contract SHALL NOT instruct the implementer to create an empty commit
- **AND** the gate SHALL derive success from the clean unchanged candidate and the observed zero exit rather than from a manufactured commit
