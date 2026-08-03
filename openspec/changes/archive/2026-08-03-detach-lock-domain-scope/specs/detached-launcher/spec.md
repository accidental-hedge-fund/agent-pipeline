## MODIFIED Requirements

### Requirement: Advisory lock serializes concurrent launches per issue
The detached wrapper process SHALL acquire the issue-run advisory lock itself, as its first
action, and hold it for its own lifetime — so the lock file always names a live process and a
launcher death cannot strand it on a dead PID. The lock identity SHALL be the shared
`(domain, issueNumber)` issue-run key (see `issue-run-lock`), not issue number alone: domain
SHALL be the same domain identity used by foreground advance for that repository (configured
or derived pipeline domain). The launcher SHALL NOT acquire the lock and transfer it to the
child after spawning. The launcher SHALL wait for the wrapper to confirm lock ownership (a
handshake) before reporting that the run started; if the wrapper reports the lock is already
held, the launcher SHALL exit non-zero with a human-readable error. The wrapper SHALL attempt
the lock for a configurable timeout (default 5 seconds). A second `--detach` invocation for
the same `(domain, issue)` that cannot acquire the lock SHALL exit non-zero. A concurrent
`--detach` for the same issue number under a **different** domain SHALL NOT be serialized by
this lock. A live foreground advance holding the same issue-run key SHALL also cause detach
acquire failure for that key (shared mutex with advance).

#### Scenario: Launcher death before lock ownership does not strand the lock
- **WHEN** the launching process dies after spawning the wrapper but before the wrapper finishes starting
- **THEN** the per-issue lock file SHALL name the wrapper (a live process), not the dead launcher
- **AND** a later `pipeline run <N> --detach` for the same domain SHALL NOT treat the lock as stale and start a concurrent duplicate run

#### Scenario: Concurrent launch for the same domain and issue is rejected
- **WHEN** `pipeline run <N> --detach` is already running for domain `D`
- **AND** a second `pipeline run <N> --detach` is invoked for domain `D`
- **THEN** the second invocation SHALL exit with a non-zero exit code
- **AND** SHALL print a message indicating issue `<N>` is already running

#### Scenario: Same issue number under different domains is not serialized
- **WHEN** `pipeline run <N> --detach` is running for domain `repo-a`
- **AND** `pipeline run <N> --detach` is invoked for domain `repo-b` on the same host
- **THEN** both SHALL acquire their respective domain-scoped locks and run concurrently without interference

#### Scenario: Different issue numbers are not serialized
- **WHEN** `pipeline run <A> --detach` and `pipeline run <B> --detach` are invoked concurrently for different issue numbers under the same domain
- **THEN** both SHALL acquire their respective locks and run concurrently without interference

#### Scenario: Lock is released when the run completes
- **WHEN** a detached run for domain `D` and issue `<N>` completes and its process exits
- **THEN** a subsequent `pipeline run <N> --detach` invocation for domain `D` SHALL be able to acquire the lock and start a new run

#### Scenario: Foreground advance holder blocks detach for the same key
- **WHEN** a foreground advance holds the issue-run lock for domain `D` and issue `<N>`
- **AND** `pipeline run <N> --detach` is invoked for domain `D`
- **THEN** the detach invocation SHALL exit non-zero or time out without starting a concurrent exclusive run for that key

## ADDED Requirements

### Requirement: Detach lock and wrapper run paths SHALL encode domain identity

Path helpers used by the detached launcher SHALL include the domain identity for the
per-issue lock and the home-dir wrapper run root (when those artifacts are stored under the
user's pipeline runs directory) so issue `N` under domain `A` never shares a lock file or
wrapper issue directory with issue `N` under domain `B`. Issue-number-only lock paths
(`…/runs/<N>/.lock` without domain) SHALL NOT be created by new code.

#### Scenario: Lock path includes domain
- **WHEN** the detach lock path is resolved for domain `repo-a` and issue `42`
- **THEN** the path or lock identity SHALL include both `repo-a` and `42`
- **AND** SHALL differ from the path or identity for domain `repo-b` and issue `42`

#### Scenario: Issue-only lock path is not used
- **WHEN** a detached run for any domain and issue acquires its advisory lock
- **THEN** the lock SHALL NOT be solely `~/.pipeline/runs/<issue>/.lock` without domain identity
