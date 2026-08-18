## ADDED Requirements

### Requirement: Concurrent detach for one milestone SHALL admit exactly one ship

Tugboat SHALL serialize probe-and-spawn when two or more overlapping `tugboat --detach` invocations target the same milestone so that exactly one invocation detaches a ship and the others take the already-running / not-detaching path. Tugboat SHALL NOT emit more than one `detached tugboat ship` line for that overlapping set. Tugboat SHALL NOT leave two live detached tugboat/train ships for that milestone as a result of the race.

The live-ship probe from the existing live-ship definition remains the meaning of “already running.” Tugboat SHALL use a host-local admission lock to serialize the check. Presence of that lock or gate alone SHALL NOT constitute a live ship. After the winner detaches, a loser SHALL refuse by re-probing live ship (or an equivalent already-running report) and SHALL NOT spawn a second copy.

This requirement is host-local. It does not claim a cross-host ship mutex.

#### Scenario: Two overlapping detaches yield one ship

- **WHEN** no live ship exists for milestone `vX.Y.Z`
- **AND** two `tugboat --detach` processes for `vX.Y.Z` overlap in time
- **THEN** exactly one process SHALL emit `detached tugboat ship`
- **AND** exactly one live ship SHALL exist for `vX.Y.Z`
- **AND** the other process SHALL NOT emit `detached tugboat ship`
- **AND** the other process SHALL take the already-running / not-detaching path

#### Scenario: Both overlapping detaches exit successfully in the success fixture

- **WHEN** two overlapping `--detach` processes for the same milestone run in the success fixture (one winner, one loser)
- **THEN** both processes SHALL exit 0
- **AND** the combined output SHALL contain exactly one `detached tugboat ship` line

#### Scenario: Sequential second detach still uses the live-ship probe

- **WHEN** a live ship already exists for `vX.Y.Z`
- **AND** a later `--detach` for `vX.Y.Z` runs after the first ship is live
- **THEN** Tugboat SHALL refuse the second detach using the live-ship probe
- **AND** it SHALL NOT refuse solely because a detach gate or lock file exists
- **AND** bare `playbook.pid` + `kill -0`, a per-issue pipeline lock, and stale `state.json` SHALL still not constitute a live ship

### Requirement: Concurrent detach regression SHALL stay enabled and fail closed

Automated checks SHALL keep a concurrent two-process `--detach` fixture for one milestone. That fixture SHALL spawn two detach processes and SHALL fail if both emit `detached tugboat ship`. The fixture SHALL NOT be deleted, skipped, or marked flaky. The fixture SHALL NOT treat a sleep-only race as the pass condition. Admission SHALL be serialized in the lock or probe, or the fixture SHALL wait on a documented lock or gate artifact before it asserts.

The fixture SHALL use a unique milestone coordinate so it does not collide with a live host ship or leftover stubs.

#### Scenario: Two detach lines fail the fixture

- **WHEN** the concurrent detach fixture runs
- **AND** both spawned processes emit `detached tugboat ship`
- **THEN** the fixture SHALL fail

#### Scenario: Fixture stays enabled

- **WHEN** an automated check inventory includes the concurrent detach fixture
- **THEN** that fixture SHALL still execute in the default `core` test run
- **AND** it SHALL NOT be skipped or marked flaky

#### Scenario: Fixture is not a sleep-only race

- **WHEN** the concurrent detach fixture asserts a single admission
- **THEN** the pass condition SHALL NOT be a sleep that hopes the second process sees the first
- **AND** either Tugboat SHALL have serialized admission before both processes can emit detach, or the fixture SHALL wait on a documented lock or gate artifact before it asserts
