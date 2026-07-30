## ADDED Requirements

### Requirement: Dirty-worktree gate failure SHALL NOT be worded as test/build fix exhaustion

The operator-facing block reason for a dirty-worktree-only test/build gate failure SHALL NOT
claim that the test/build gate failed after N fix attempt(s) and SHALL NOT claim that the
repo's own test/build command is still failing. This applies when the gate blocks solely
because the worktree is dirty — either before the first trusted command run (pre-dirty) or
after a passing command that left uncommitted artifacts (post-run dirty) — and the gate has
not entered the generate→test→fix loop as a genuine test failure. The reason SHALL identify
the failure as a dirty-worktree / uncommitted-changes trust refusal (using the gate's dirty
`blockReason` text or an equally accurate pass-through), and SHALL retain path disclosure for
uncommitted paths when that disclosure is already part of the gate result. Genuine command
failures that exhaust `max_attempts` fix attempts SHALL continue to use the existing
exhaustion wording.

#### Scenario: Pre-dirty block is not wrapped as fix exhaustion

- **WHEN** the worktree has uncommitted changes before the gate runs
- **AND** the gate returns a failed result with attempts 0 without invoking the fix harness
- **AND** the pipeline formats that result for an operator-facing blocker
- **THEN** the formatted reason SHALL identify uncommitted changes / dirty worktree as the
  cause
- **AND** the formatted reason SHALL NOT match the pattern of “failed after N fix attempt(s)”
- **AND** the formatted reason SHALL NOT claim that the repo's own test/build command is still
  failing
- **AND** the formatted reason SHALL still include uncommitted path disclosure when the gate
  result carries porcelain paths

#### Scenario: Post-run dirty block is not wrapped as fix exhaustion

- **WHEN** the test/build command exits 0 but leaves the tree dirty
- **AND** the gate blocks with attempts 0 without charging a fix attempt for that dirt
- **AND** the pipeline formats that result for an operator-facing blocker
- **THEN** the formatted reason SHALL identify leftover uncommitted artifacts / dirty tree
- **AND** the formatted reason SHALL NOT claim fix-attempt exhaustion or that the test/build
  command is still failing

#### Scenario: Exhausted real test failures keep exhaustion wording

- **WHEN** the test/build command fails with a cleanly observed non-zero exit
- **AND** fix attempts are exhausted under `test_gate.max_attempts`
- **THEN** the operator-facing block reason SHALL still indicate failure after N fix
  attempt(s) (or equivalent exhaustion wording)
- **AND** that wording SHALL remain distinct from dirty-worktree refusal reasons

#### Scenario: Dirty vs exhaustion distinction is unit-testable without real git

- **WHEN** a unit test constructs a pre-dirty `TestGateResult` (attempts 0, dirty blockReason,
  no fix harness run) and formats it with `testGateBlockReason` (or the equivalent public
  formatter)
- **THEN** the test SHALL assert the output does not claim fix-attempt exhaustion or command
  still failing
- **AND** SHALL assert a real exhausted test-failure result still receives exhaustion wording
- **AND** the test SHALL perform no real git, network, or subprocess call
