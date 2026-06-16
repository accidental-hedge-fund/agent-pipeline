## MODIFIED Requirements

### Requirement: Capture-then-verify pattern for all harness-instruction steps

Every pipeline step that invokes a harness and prescribes a machine-checkable output property SHALL capture the current HEAD SHA immediately before harness invocation, then after the harness returns, check for uncommitted changes before verifying commit-range invariants. If uncommitted changes are present and no new commit is in the range, the step SHALL invoke the salvage path (see `harness-uncommitted-salvage` spec) to create a commit before running the commit-range verification. Steps that prescribe no commit-producing behavior are exempt from commit-range checks. After commit-range verification completes, the implementing and fix-round steps SHALL additionally run the format gate (see `harness-format-lint-gate`) before opening or updating the PR.

#### Scenario: HEAD captured before harness invocation

- **WHEN** any harness-instruction step is about to invoke the harness
- **THEN** the step SHALL record the output of `git rev-parse HEAD` in a `headBefore` variable before spawning the harness process

#### Scenario: Dirty worktree triggers salvage before commit-range verification

- **WHEN** the harness exits and `headBefore === headAfter` (no new commit)
- **AND** the worktree contains uncommitted changes
- **THEN** the step SHALL invoke `salvageUncommittedWork` to create a salvage commit before running `verifyHarnessCommits` on the resulting range

#### Scenario: Verification runs on the produced commit range

- **WHEN** the harness exits with code 0 and at least one commit exists in `headBefore..HEAD` (whether harness-produced or salvaged)
- **THEN** the step SHALL verify its prescribed invariants against commits in `headBefore..HEAD`
- **AND** the step SHALL block (return `blocked` with a descriptive reason) if any invariant is violated
- **AND** the step SHALL NOT advance to the next stage on a violation

#### Scenario: Clean worktree with no commits still blocks

- **WHEN** the harness exits and no new commit was produced
- **AND** the worktree is clean (no uncommitted changes)
- **THEN** the step SHALL block with `"No commits found in the range; the harness was expected to produce at least one commit"` and SHALL NOT invoke salvage

#### Scenario: Format gate runs after commit-range verification for implementing and fix-round steps

- **WHEN** the implementing or fix-round harness exits 0 and commit-range verification passes
- **AND** `config.format_gate` is non-empty
- **THEN** the step SHALL invoke `runFormatGate` before opening or updating the PR
- **AND** if `runFormatGate` returns a `blocked` result, the step SHALL propagate the block and SHALL NOT open or update the PR
