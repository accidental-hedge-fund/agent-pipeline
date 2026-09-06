## ADDED Requirements

### Requirement: Spawn-real Tugboat lifecycle fixtures SHALL complete cleanup only after owned processes are gone and writers are closed

Spawn-real Tugboat lifecycle fixtures SHALL delete a fixture temp tree only after every fixture-owned process is reaped and awaited, and after stdout and stderr writers and watchers owned by that fixture are closed. Those fixtures SHALL include the SIGTERM wait-for-live fixture, the concurrent two-process detach fixture, wait-for-live expiry and re-parent reap fixtures, and other detach lifecycle fixtures that spawn a real Tugboat child and then remove a temp tree. A kill signal without an observed death SHALL NOT count as complete. Parent process exit of the Node test worker SHALL NOT count as complete. A fixed sleep SHALL NOT be the completeness observer.

#### Scenario: Temp-tree delete waits for owned process death

- **WHEN** a spawn-real Tugboat lifecycle fixture has sent terminate to its owned children
- **AND** at least one owned process is still live
- **THEN** the fixture SHALL NOT delete its temp tree yet
- **AND** it SHALL wait until those owned processes are gone or a named finite deadline expires

#### Scenario: Writers and watchers close before delete

- **WHEN** a spawn-real Tugboat lifecycle fixture has open stdout or stderr pipes or data watchers on a spawned child
- **THEN** it SHALL close those writers and watchers before it deletes the temp tree

#### Scenario: Shared seam covers sibling lifecycle fixtures

- **WHEN** the concurrent detach fixture, wait-for-live expiry fixture, re-parent reap fixture, failed wait-for-live fixture, sequential detach fixture, or stale-admission fixture finishes
- **THEN** that fixture SHALL use the same cleanup completeness rule as the SIGTERM wait-for-live fixture
- **AND** it SHALL NOT kill owned children and then immediately recursive-delete the temp tree while those children may still mutate it

### Requirement: Tugboat lifecycle fixture cleanup SHALL be ownership-safe, bounded, and fail closed

Tugboat lifecycle fixture cleanup SHALL terminate only fixture-owned processes: processes whose command line contains the fixture temp directory, processes whose command line contains that fixture's unique `--milestone v<version>` coordinate, and the pid recorded in that fixture's `playbook.pid` when present and when that pid's current command line still contains the fixture temp directory or that unique milestone coordinate. Cleanup SHALL NOT send a signal to unrelated host processes. Cleanup SHALL treat a zombie (`/proc/<pid>/stat` state `Z`) as not mutating and SHALL NOT use `kill(pid, 0)` alone as the still-mutating test. Cleanup SHALL use a named finite deadline. Cleanup SHALL NOT poll without a deadline and SHALL NOT sleep without a bound. If live owned processes remain, or the temp tree is still mutating, when the deadline expires, cleanup SHALL fail closed and SHALL name remaining owned pids with ownership source and argv. Cleanup SHALL NOT swallow `ENOTEMPTY` or an equivalent still-mutating unlink error as success. Cleanup SHALL NOT hide a live descendant. Cleanup SHALL NOT weaken the SIGTERM wait-for-live product assertions (fail closed, no `detached tugboat ship` line, unconfirmed child gone, later detach admits exactly one live ship).

#### Scenario: Unrelated host processes are not killed

- **WHEN** a lifecycle fixture cleans up
- **AND** other processes on the host do not match the fixture temp directory, unique milestone coordinate, or recorded `playbook.pid` whose current argv still matches
- **THEN** cleanup SHALL NOT signal those processes

#### Scenario: Reused playbook.pid is not signaled

- **WHEN** a lifecycle fixture's `playbook.pid` names a live pid
- **AND** that pid's current command line does not contain the fixture temp directory or the fixture's unique milestone coordinate
- **THEN** cleanup SHALL NOT signal that pid

#### Scenario: Zombie is not treated as still mutating

- **WHEN** a fixture-owned pid exists in `/proc` with stat state `Z`
- **THEN** cleanup SHALL treat that pid as not mutating
- **AND** it SHALL NOT wait for `kill(pid, 0)` to throw `ESRCH` before it may delete the temp tree

#### Scenario: Deadline with remaining owned pids fails closed

- **WHEN** the named cleanup deadline expires
- **AND** at least one fixture-owned process is still live (non-zombie)
- **THEN** cleanup SHALL fail
- **AND** the failure SHALL name remaining owned pids with ownership source and argv
- **AND** the failure SHALL NOT be reported as a successful temp-tree delete

#### Scenario: ENOTEMPTY is not swallowed

- **WHEN** recursive delete of the fixture temp tree hits `ENOTEMPTY` or an equivalent still-mutating unlink error
- **THEN** cleanup SHALL retry only inside the named deadline after another reap of owned processes
- **AND** if the tree is still mutating at the deadline, cleanup SHALL fail
- **AND** it SHALL NOT catch-and-ignore that error as a pass

#### Scenario: Product SIGTERM assertions stay load-bearing

- **WHEN** the SIGTERM wait-for-live fixture runs
- **THEN** it SHALL still assert the signaled detach fails closed
- **AND** it SHALL still assert output does not contain `detached tugboat ship`
- **AND** it SHALL still assert the unconfirmed child is gone (`ESRCH`)
- **AND** it SHALL still assert a later `--detach` for the same milestone admits exactly one live ship

### Requirement: The SIGTERM wait-for-live fixture SHALL stay enabled and SHALL NOT fail on cleanup ENOTEMPTY after green product assertions

Automated checks SHALL keep the SIGTERM wait-for-live fixture that proves Tugboat reaps an unconfirmed child before unlock. That fixture SHALL still execute in the default `core` test run. The fixture SHALL NOT be deleted, skipped, or marked flaky. After its product assertions pass, fixture cleanup SHALL NOT throw `ENOTEMPTY` or an equivalent still-mutating unlink error.

#### Scenario: Fixture stays enabled

- **WHEN** an automated check inventory includes the SIGTERM wait-for-live fixture
- **THEN** that fixture SHALL still execute in the default `core` test run
- **AND** it SHALL NOT be skipped or marked flaky

#### Scenario: Cleanup does not fail a green SIGTERM product run

- **WHEN** the SIGTERM wait-for-live fixture product assertions have passed
- **AND** the fixture then deletes its temp tree
- **THEN** that delete SHALL complete without `ENOTEMPTY`
- **AND** the test result SHALL remain a pass when product assertions passed

### Requirement: Automated checks SHALL prove naive mutating-tree delete throws ENOTEMPTY and the shared seam then succeeds

Automated checks SHALL include a bite that keeps a writer mutating a temp tree while a naive recursive delete runs. The bite SHALL wait for a writer-ready handshake before the naive delete, and SHALL use a bounded contention loop with a named deadline. That naive delete SHALL throw `ENOTEMPTY` or an equivalent still-mutating unlink error. If the naive delete never throws by that deadline, the bite SHALL fail and SHALL report writer pid, liveness, argv, and tree listing. The same checks SHALL then run the shared lifecycle cleanup seam against that writer and SHALL delete the tree only after the writer is reaped. The bite SHALL fail if the shared seam is replaced by an immediate recursive delete, a catch-and-ignore of `ENOTEMPTY`, or a skip of the SIGTERM fixture.

#### Scenario: Naive delete bites on a live writer

- **WHEN** a writer process is creating files under a temp tree
- **AND** the writer has written its ready handshake
- **AND** a naive recursive delete of that tree runs without waiting for the writer to exit
- **THEN** the delete SHALL throw `ENOTEMPTY` or an equivalent still-mutating unlink error
- **AND** if no such throw occurs before the bite deadline, the check SHALL fail with writer diagnostics

#### Scenario: Shared seam reaps then deletes

- **WHEN** the same writer is mutating a temp tree
- **AND** the shared lifecycle cleanup seam runs
- **THEN** the seam SHALL terminate and await that writer
- **AND** it SHALL then delete the tree without `ENOTEMPTY`

#### Scenario: Catch-and-ignore is not a pass

- **WHEN** the bite is changed to catch `ENOTEMPTY` and continue without reaping the writer
- **THEN** the bite SHALL fail
