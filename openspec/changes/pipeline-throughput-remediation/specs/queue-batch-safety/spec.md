## ADDED Requirements

### Requirement: Queue batch launches are serialized

The `pipeline queue` command SHALL acquire a repo-local batch lock before listing and launching eligible issues. If another live queue process already owns the lock, the command SHALL exit with a clear error and SHALL NOT launch any issue. A stale lock from a dead process SHALL NOT permanently block queue use.

#### Scenario: Concurrent queue invocation is rejected
- **WHEN** one `pipeline queue` process owns the queue batch lock
- **AND** a second `pipeline queue` command starts in the same repository
- **THEN** the second command SHALL report that another queue batch is active
- **AND** it SHALL NOT call the issue-launching runner

#### Scenario: Stale queue lock is cleared
- **WHEN** the queue batch lock exists but its owning process is no longer live
- **THEN** the next `pipeline queue` invocation SHALL clear the stale lock
- **AND** it SHALL acquire the lock and proceed normally
