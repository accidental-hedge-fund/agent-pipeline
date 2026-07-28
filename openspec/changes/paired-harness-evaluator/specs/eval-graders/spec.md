## MODIFIED Requirements

### Requirement: Implementation and fix cells SHALL be graded on hidden tests, acceptance criteria, regressions, and out-of-scope changes

The same deterministic implementation grade SHALL apply to a completed paired cell using its final worktree checks and changed paths. Paired convergence data SHALL remain a separate, additive observation and SHALL NOT alter the deterministic implementation grade.

#### Scenario: A paired fix is graded at final state

- **WHEN** a paired cell invokes its primary fix stage
- **THEN** implementation grading SHALL evaluate checks and changed paths after that fix
- **AND** SHALL retain the paired convergence observation separately
