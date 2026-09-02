## MODIFIED Requirements

### Requirement: The engine SHALL provide a stage-agnostic no-new-commit goal-satisfaction contract

The pipeline SHALL expose a single shared evaluation surface (module/API under `core/scripts/`) that, when a harness or equivalent commit-producing round ends with **no new commit** after salvage has run (or correctly determined there is nothing to salvage), evaluates whether the worktree **HEAD already satisfies the declaring stage’s goal**. The evaluation SHALL return a closed decision among at least: **advance** (goal satisfied), **escalate** (goal not satisfied), and **not-applicable** (path is not a clean no-new-commit case — non-empty commit range, successful salvage commit, or insufficient inputs). Stage modules SHALL NOT each maintain a private full copy of this control skeleton once migrated; stage-specific product meaning of “goal” SHALL remain stage-supplied via explicit goal checks. An **escalate** decision SHALL be an operation observation. RecoverySupervisor SHALL own treatment. The stage adapter SHALL NOT terminalize the Logical Operation.

#### Scenario: Clean no-new-commit with satisfied goal advances

- **WHEN** a migrated stage’s harness round ends with `headAfter === headBefore`, salvage creates no commit, and the stage’s goal check reports satisfied at HEAD
- **THEN** the shared evaluation SHALL return **advance**
- **AND** the stage SHALL NOT invent an empty commit solely to pass a commit-range check
- **AND** the stage SHALL NOT call `setBlocked` with `blockerKind: "no-commits"` solely because no new commit was produced

#### Scenario: Clean no-new-commit with unsatisfied goal escalates

- **WHEN** a migrated stage’s harness round ends with `headAfter === headBefore`, salvage creates no commit, and the stage’s goal check reports unsatisfied
- **THEN** the shared evaluation SHALL return **escalate**
- **AND** the adapter SHALL emit a typed observation for that unsatisfied no-op
- **AND** SHALL NOT treat the round as a silent success
- **AND** SHALL NOT mark the Logical Operation complete, cancelled, or human-owned
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Non-empty commit range is not-applicable

- **WHEN** a harness round produces one or more new commits in the captured range
- **THEN** the shared evaluation SHALL return **not-applicable**
- **AND** the stage SHALL continue its existing commit-gate / advance path without goal-satisfaction short-circuit

#### Scenario: Successful salvage commit is not-applicable to clean-noop advance

- **WHEN** salvage creates a commit after a dirty no-new-commit harness exit
- **THEN** the shared evaluation SHALL return **not-applicable** (or SHALL NOT classify the result as clean-noop goal advance)
- **AND** the stage SHALL follow the existing post-salvage verification path

#### Scenario: Unconfirmed clean/no-salvage status is not-applicable

- **WHEN** `headAfter === headBefore` and salvage did not create a commit, but confirmed clean/no-salvage status is not true (salvage skipped, salvage failed, or worktree cleanliness not proven)
- **THEN** the shared evaluation SHALL return **not-applicable**
- **AND** SHALL NOT invoke the stage goal check solely because HEADs are equal
- **AND** callers SHALL NOT synthesize placeholder HEAD values or treat artifact-directory presence as proof of a clean worktree
