## ADDED Requirements

### Requirement: Pre-merge base-branch merge conflict is not human authority by default

The reporting kind `merge-conflict-or-branch-drift` (and any projection of a pre-merge
true CONFLICTING/DIRTY recovery) SHALL remain a metrics / reporting dimension only
unless a separate current human-authority diagnostic is present. A first clean
auto-rebase conflict during pre-merge recovery SHALL NOT authorize a human hold,
`needs-human` authority transition, or suppression of engine-owned conflict
resolution solely because that reporting kind exists. Engine-owned recovery
(bounded resolve → push → re-enter pre-merge) remains mandatory until resolution
budget exhaustion maps to a product / engine-owned failure, not a “manual rebase
needed” human class.

#### Scenario: First-conflict recovery does not grant human authority via taxonomy

- **WHEN** pre-merge detects CONFLICTING or DIRTY mergeability and clean auto-rebase
  hits conflicts
- **THEN** classification MAY still record a reporting projection related to
  merge-conflict-or-branch-drift for metrics if needed
- **AND** that projection alone SHALL NOT create a human hold or authorize skipping
  engine-owned conflict resolution
- **AND** recovery SHALL proceed under engine-owned pre-merge conflict law until
  budget exhaustion or success

#### Scenario: Budget-exhausted product failure is not manual-rebase human class

- **WHEN** pre-merge conflict resolution budget is exhausted with residual conflicts
- **THEN** any human-intervention reporting kind SHALL NOT re-label the terminal as
  operator “manual rebase needed” authority solely for that exhaust
- **AND** the terminal SHALL remain a product / engine-owned failure with conflict
  evidence as specified by pre-merge-conflict-detection
