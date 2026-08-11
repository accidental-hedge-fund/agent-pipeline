## Purpose

Pin unit-test regression ceilings on injectable GitHub deps-invocation counts for the pre-merge multi-tick CI poll path and a full advance walk, so amortization wins (especially the pre-merge entry-gate head memo) cannot silently erode without failing `npm test`.

## ADDED Requirements

### Requirement: Pre-merge poll path SHALL assert a pinned deps-invocation ceiling

The test suite SHALL include a unit test that drives the pre-merge poll path with a shared polling context, injectable deps only (no real network, git, or subprocess), and a stubbed checks reader that returns pending for a fixed number of ticks N where N is at least 10. The test SHALL sum deps invocations across that multi-tick session and SHALL assert that the total is less than or equal to a named constant ceiling. The constant SHALL be defined as an explicit identifier (not an inline magic number) and SHALL carry a comment that states it guards against regression of the entry-gate head memo amortization and related redundant per-tick GitHub work.

#### Scenario: Pending multi-tick poll stays under the pinned ceiling

- **WHEN** the pre-merge poll budget test runs with injectable deps
- **AND** checks remain pending for N ticks with N ≥ 10
- **AND** the open PR head SHA is unchanged for the session
- **THEN** the summed deps-invocation count for the session SHALL be ≤ the named pre-merge poll ceiling constant
- **AND** the test SHALL use no real network, git, or subprocess calls

#### Scenario: Ceiling constant is named and documented

- **WHEN** a maintainer inspects the pre-merge poll budget test source
- **THEN** the ceiling SHALL appear as a named constant identifier
- **AND** a comment near that constant SHALL state which regression it catches (entry-gate head memo / redundant per-tick entry work)

---

### Requirement: Pre-merge poll ceiling SHALL fail if the entry-gate head memo is removed

The pre-merge poll budget ceiling SHALL be calibrated so that re-running the full head-bound entry-gate stack on every pending tick for the same N-tick fixture exceeds the ceiling. Removing or bypassing the entry-gate head-SHA proceed memo (so head-bound gates re-execute every tick while head is unchanged) SHALL cause the pre-merge poll budget assertion to fail under `npm test`.

#### Scenario: Full per-tick entry stack exceeds the ceiling

- **WHEN** the same N-tick pending fixture is evaluated as if head-bound entry gates ran on every tick (memo miss / memo removed)
- **THEN** the resulting deps-invocation total SHALL be greater than the named pre-merge poll ceiling
- **AND** the memo-enabled path for that fixture SHALL remain ≤ the ceiling

#### Scenario: Test fails when memo skip path is absent

- **WHEN** the entry-gate head memo skip path is removed or forced never to hit while head is unchanged
- **AND** the pre-merge poll budget test runs against the N-tick pending fixture
- **THEN** the test SHALL fail the ceiling assertion

---

### Requirement: Full advance walk SHALL assert a pinned deps-invocation ceiling

The test suite SHALL include a unit test that drives a deterministic full advance walk with injectable deps only (no real network, git, or subprocess) and asserts that the total deps-invocation count is less than or equal to a second named constant ceiling. That constant SHALL be defined as an explicit identifier with a comment stating it guards against silent reintroduction of redundant GitHub reads across the advance path.

#### Scenario: Deterministic advance walk stays under the pinned ceiling

- **WHEN** the advance-walk budget test runs with injectable deps and fixed fixtures
- **THEN** the summed deps-invocation count SHALL be ≤ the named advance-walk ceiling constant
- **AND** the test SHALL use no real network, git, or subprocess calls

#### Scenario: Advance-walk ceiling constant is named and documented

- **WHEN** a maintainer inspects the advance-walk budget test source
- **THEN** the ceiling SHALL appear as a named constant identifier
- **AND** a comment near that constant SHALL state which regression it catches

---

### Requirement: Budget assertions SHALL not alter pipeline gate policy

The budget regression gates SHALL be test-only assertions. They SHALL NOT remove, demote, or skip any review step, SHA gate, OpenSpec archive fail-closed path, active-change guard, CI recovery ladder, or merge authority rule. They SHALL NOT introduce runtime production hard-fails based on exceeding a call budget during a live advance. Reconcile-cycle budget assertion is outside this capability and SHALL NOT be required for this capability to be complete.

#### Scenario: Production advance does not hard-fail on call count

- **WHEN** a live (non-test) advance performs more `gh` or deps calls than a unit-test ceiling constant
- **THEN** the pipeline SHALL NOT abort solely because a unit-test budget constant was exceeded
- **AND** review and pre-merge gate policies SHALL remain unchanged by this capability

#### Scenario: Reconcile-cycle budget is not required here

- **WHEN** this capability's unit tests run
- **THEN** they SHALL NOT be required to assert a reconcile-cycle deps-invocation ceiling
- **AND** absence of a reconcile-cycle budget test SHALL NOT fail this capability's acceptance
