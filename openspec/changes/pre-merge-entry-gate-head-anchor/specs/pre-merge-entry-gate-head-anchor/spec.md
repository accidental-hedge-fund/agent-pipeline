## Purpose

Amortize the pre-merge **head-bound** pre-CI entry-gate stack across CI poll ticks within one polling session by recording a head-SHA-keyed proceed memo, so unchanged heads do not re-run those gates while any head movement re-runs the full stack, early-conflict remains per-tick, and gate policy is not weakened.

## ADDED Requirements

### Requirement: Pre-merge polling context SHALL carry a head-SHA entry-gate proceed memo

When pre-merge runs under a shared polling context (the session object passed across `advancePolling` re-invocations of `advance`), that context SHALL expose an optional field recording the PR head SHA for which the head-bound pre-CI entry-gate stack already produced a clean proceed into the CI step. The field SHALL be session-scoped and ephemeral (not a durable cross-process ledger entry for this capability). Absence of a polling context SHALL preserve today’s behavior: every `advance` invocation runs the full entry-gate stack.

#### Scenario: Memo field exists on the polling session context

- **WHEN** a pre-merge polling session is started for an issue
- **THEN** the shared polling context SHALL be able to store `entryGatesPassedForSha` as an optional string head SHA
- **AND** the field SHALL start unset before any successful entry-gate proceed in that session

#### Scenario: One-shot advance without polling context is unchanged

- **WHEN** `advance` runs without a polling context
- **THEN** the entry-gate stack SHALL run in full on that invocation
- **AND** no entry-gate proceed memo SHALL be consulted or required

---

### Requirement: Head-bound entry gates SHALL run once per head SHA per polling session on proceed

Within a single pre-merge polling session, when the current open PR head SHA equals the stored `entryGatesPassedForSha`, the pipeline SHALL skip re-execution of the head-bound pre-CI entry gates (review-SHA gate, OpenSpec archive step, and head-side active-change guard) and SHALL still evaluate early-conflict and the CI step for that tick. When the memo is unset or the current head SHA differs, the pipeline SHALL run the full entry-gate stack in the existing order before early-conflict and the CI step.

#### Scenario: Same head on later ticks skips head-bound gates only

- **WHEN** a polling session has `entryGatesPassedForSha` equal to the current open PR head SHA
- **AND** `advance` is re-invoked for a CI wait tick
- **THEN** the pipeline SHALL NOT re-invoke the review-SHA gate, OpenSpec archive, or active-change guard for that tick
- **AND** SHALL still evaluate early-conflict from the current PR detail for that tick
- **AND** SHALL still evaluate the CI step (including pending-check polling) for that tick

#### Scenario: First tick or missing memo runs the full stack

- **WHEN** a polling session has no `entryGatesPassedForSha` (or it is empty)
- **THEN** the pipeline SHALL run the full pre-CI entry-gate stack before early-conflict and the CI step
- **AND** on a clean proceed into the CI step SHALL set `entryGatesPassedForSha` to the head SHA that entered the CI step

#### Scenario: Multi-tick pending CI reduces head-bound entry-gate work after first proceed

- **WHEN** a test drives a polling session for at least 10 ticks with injectable deps
- **AND** CI checks remain pending and the open PR head SHA is unchanged
- **THEN** after the first tick that records a proceed memo, subsequent ticks SHALL not re-run the head-bound entry-gate stack
- **AND** the per-tick count of load-bearing GitHub (or equivalent injected) calls for those later ticks SHALL drop to the CI-path reads (on the order of PR detail/head/mergeability and checks), not the full pre-memo entry stack

---

### Requirement: Early-conflict SHALL still run every tick under a head-SHA proceed memo

Skipping head-bound entry gates under a matching `entryGatesPassedForSha` SHALL NOT skip early-conflict detection. The pipeline SHALL re-evaluate the early-conflict predicate from the current per-tick open PR detail even when the head SHA matches the proceed memo, because base-branch movement can make a PR CONFLICTING or DIRTY without changing the PR head.

#### Scenario: Unchanged head with base-driven DIRTY takes conflict recovery

- **WHEN** a polling session has `entryGatesPassedForSha` equal to the current PR head SHA
- **AND** the current PR detail reports `mergeable === false` or uppercased `mergeable_state === "DIRTY"`
- **THEN** the pipeline SHALL take the early-conflict path (merge-conflict recovery) as today
- **AND** SHALL NOT treat the head-SHA memo alone as permission to skip conflict handling

#### Scenario: Early-conflict predicate unchanged after detail hoist

- **WHEN** PR detail reports `mergeable === false` or uppercased `mergeable_state === "DIRTY"`
- **THEN** the pipeline SHALL take the early-conflict path as today (skip waiting for CI runs that cannot appear)
- **AND** when mergeability is UNKNOWN/null or state is BEHIND/BLOCKED without DIRTY, the pipeline SHALL fall through toward the CI step as today

---

### Requirement: The entry-gate memo SHALL record only a clean proceed verdict

The pipeline SHALL set `entryGatesPassedForSha` only when the full head-bound entry-gate stack completes without returning a non-proceed outcome, early-conflict does not divert to recovery return, and control continues into the CI step. Any non-null entry-gate result (block, re-route to review/fix, archive failure, active-change guard failure, early-conflict recovery return, or other terminal/waiting outcome from those gates) SHALL NOT set the memo for that head. A later tick with the same head after a non-proceed MUST re-run the head-bound entry-gate stack unless a subsequent full pass has since recorded a clean proceed.

#### Scenario: Blocking or waiting entry-gate outcome does not set the memo

- **WHEN** the review-SHA gate, OpenSpec archive, or active-change guard returns a non-null outcome that ends the current `advance` call
- **THEN** `entryGatesPassedForSha` SHALL remain unset for that head (or retain only a prior proceed for a different head)
- **AND** the next `advance` in the same session with the same head SHALL re-run the head-bound entry-gate stack

#### Scenario: Early-conflict recovery return does not set the memo

- **WHEN** the early-conflict path routes to merge-conflict recovery and returns from `advance` without entering the CI step as a clean proceed
- **THEN** the pipeline SHALL NOT set `entryGatesPassedForSha` for the conflicting head as a proceed memo
- **AND** a later tick SHALL re-evaluate entry gates unless a later clean proceed for that head is recorded

#### Scenario: Proceed into CI sets the memo to the entering head

- **WHEN** the entry-gate stack completes with no non-proceed return
- **AND** the PR is not treated as an early conflict that skips the CI step via recovery return
- **THEN** before or as control enters the CI step the pipeline SHALL set `entryGatesPassedForSha` to the current PR head SHA used for that CI entry
- **AND** that SHA SHALL reflect post-stack head when an earlier step in the same pass moved HEAD (for example an OpenSpec archive commit)

---

### Requirement: Any head movement SHALL invalidate the entry-gate memo

The pipeline SHALL treat any change of the PR head SHA as memo invalidation. Developer pushes, fix commits, auto-fix commits, archive commits, rebases, and any other head movement SHALL cause a full re-run of the head-bound entry-gate stack on the next `advance` that observes the new head. Equality of head SHA is the sole positive skip condition for those gates; the pipeline SHALL NOT skip them based on wall-clock, tick count, or CI pending state alone.

#### Scenario: Head SHA change re-runs every head-bound entry gate

- **WHEN** `entryGatesPassedForSha` is set to head H1
- **AND** a later tick observes PR head SHA H2 where H2 ≠ H1
- **THEN** the pipeline SHALL run the full head-bound entry-gate stack for H2
- **AND** SHALL NOT skip those gates solely because a memo exists for H1

#### Scenario: Invalidation regression fails if head check is removed

- **WHEN** a regression test simulates a proceed memo for H1 then supplies head H2 with pending CI
- **THEN** the test SHALL assert that head-bound entry-gate deps run again for H2
- **AND** that assertion SHALL fail if the implementation skips the stack whenever any memo is set without comparing to the current head

---

### Requirement: PR identity and detail SHALL be resolved for head anchoring with open-PR validity

Within a polling session, the pipeline SHALL resolve PR number and PR detail early enough to (1) compare `entryGatesPassedForSha` to `head_sha`, (2) apply the early-conflict predicate, and (3) enter the CI step. The pipeline MAY cache the resolved PR number on the polling context for reuse within the same session. Cached PR identity SHALL be treated as valid only while a detail read shows that PR is still open. If the cached PR is closed, merged, missing, or otherwise not open, the pipeline SHALL clear the cached number and the entry-gate proceed memo, re-resolve the issue’s current open PR (if any), and continue with that identity (or the existing no-PR block path).

#### Scenario: Cached PR number is session-scoped for open PRs

- **WHEN** a polling session has already resolved an open PR number for the issue and stored it on the polling context
- **AND** a later tick’s detail read still shows that PR open
- **THEN** later ticks in that session MAY reuse that PR number without repeating a full repo-wide open-PR scan

#### Scenario: Closed or replaced PR invalidates cached identity

- **WHEN** a polling session has a cached PR number
- **AND** a later tick’s detail read shows that PR is not open (closed/merged/missing)
- **THEN** the pipeline SHALL clear the cached PR number and `entryGatesPassedForSha`
- **AND** SHALL re-resolve the issue’s open PR via the existing issue→PR resolution path before continuing entry gates or CI
- **AND** SHALL NOT continue polling the closed or missing PR as if it were still the active target

#### Scenario: Missing or new polling session resolves PR number again

- **WHEN** a missing or new polling session has no cached PR number
- **THEN** the pipeline SHALL resolve the PR number again before entry gates

---

### Requirement: Entry-gate head anchoring SHALL not remove or weaken gates

Skipping head-bound entry gates under a matching head-SHA proceed memo SHALL NOT remove, demote, disable, or policy-condition the review-SHA gate, OpenSpec archive, active-change guard, early-conflict detection, or CI certification. The only additional condition for skip of head-bound gates is that the current head equals a head that already cleanly proceeded through those gates in the same polling session. Early-conflict, CI polling, recovery ladders, and post-CI mergeability checks remain in force on every relevant tick.

#### Scenario: CI step still runs every wait tick

- **WHEN** head-bound entry gates are skipped due to a matching `entryGatesPassedForSha`
- **THEN** the CI step SHALL still run and may return waiting, advanced, blocked, or recovery outcomes exactly under existing CI-gate contracts

#### Scenario: No rigor demotion via config or tick count

- **WHEN** the entry-gate head-anchor path is enabled by the presence of a polling context
- **THEN** there SHALL be no configuration switch that disables the review-SHA gate or other entry gates while leaving pre-merge advance enabled
- **AND** skip SHALL NOT be granted solely because N ticks have elapsed
