# harness-background-job-lifecycle Specification

## Purpose
Gives the pipeline a versioned adapter lifecycle for background jobs so a product-mutating
harness cannot hang until `implementation_timeout` waiting for a notification that never
arrives, and so that miss is a distinct `harness-background-wait` rather than a timeout.

## Requirements

### Requirement: Supporting adapters SHALL stream versioned background-job lifecycle events

The pipeline SHALL define a versioned adapter capability named `background_job_lifecycle`. When
an adapter declares that capability supported, it SHALL stream typed events for each background
job that carry stable job identity, start, completion or failure, notification delivery, and
foreground-join, correlated to the adapter name and the current invocation. Event schema version
`pipeline/background-job-lifecycle@1` SHALL be the initial version. An adapter that cannot map
its raw protocol onto those events SHALL declare the capability unsupported and SHALL NOT emit
invented events.

#### Scenario: A supporting adapter emits the required event set for a joined job

- **WHEN** a supporting adapter starts a background job and later delivers its result into the
  foreground
- **THEN** the pipeline SHALL observe typed events for job identity, start, completion or
  failure, notification delivery, and foreground-join
- **AND** those events SHALL share one stable job identity correlated to that invocation

#### Scenario: An unmappable protocol is declared unsupported

- **WHEN** an adapter's raw protocol cannot prove job identity, start, completion or failure,
  notification delivery, and foreground-join
- **THEN** that adapter SHALL declare `background_job_lifecycle` unsupported
- **AND** SHALL NOT synthesize those events from transcript wording

### Requirement: Lifecycle evidence SHALL be allowlisted and redacted

The pipeline SHALL persist and emit only allowlisted lifecycle evidence: adapter identity,
invocation correlation, stable job identity, timestamps, and job state. Lifecycle evidence SHALL
NOT include raw commands, tool output, prompts, or secrets. Redaction SHALL apply before the
evidence is stored, logged, or attached to a diagnostic.

#### Scenario: Join evidence names job state without command text

- **WHEN** a background job completes and the pipeline records lifecycle evidence
- **THEN** the evidence SHALL include adapter identity, invocation correlation, job identity,
  timestamps, and state
- **AND** SHALL NOT include the job's command string, tool output, prompt text, or secrets

#### Scenario: Malformed events are redacted and not treated as a join

- **WHEN** a lifecycle event is malformed or carries a duplicate job identity with conflicting
  state
- **THEN** the pipeline SHALL NOT treat that event as a successful foreground-join
- **AND** any retained diagnostic evidence SHALL still exclude raw commands, tool output,
  prompts, and secrets

### Requirement: Transcript wording and inactivity SHALL NEVER prove a background wait

The pipeline SHALL classify `harness-background-wait` only from typed lifecycle events that show
a job completed or failed without notification delivery or foreground-join inside the effective
grace period. Transcript wording, model prose, and generic inactivity SHALL NEVER be sufficient
proof of a background wait.

#### Scenario: Waiting prose does not emit harness-background-wait

- **WHEN** the harness transcript contains wording such as "I'll wait for the background test
  run's notification" and no typed complete-or-fail lifecycle event exists for an outstanding job
- **THEN** the pipeline SHALL NOT emit `harness-background-wait` from that wording

#### Scenario: Silence without complete-or-fail is not a background wait

- **WHEN** a supporting adapter has a started job with no complete or fail event and no other
  typed lifecycle proof of a missed delivery or join
- **THEN** the pipeline SHALL NOT emit `harness-background-wait` from inactivity alone

### Requirement: A running background job MAY continue until the outer stage deadline

The pipeline SHALL permit background execution on a supporting adapter. A job that has started
and has not completed or failed SHALL be allowed to continue for the remaining
`implementation_timeout` (or the stage's existing wall-clock cap). That outer cap SHALL remain
the deadline for still-running work. Expiry of the outer cap while the job is still running
SHALL classify as `harness-timeout` and SHALL NOT classify as `harness-background-wait`.

#### Scenario: A legitimate long-running job is not a background wait

- **WHEN** a supporting adapter emits a typed start for a background job
- **AND** no complete or fail event arrives before the outer stage cap
- **THEN** the pipeline SHALL allow the job to run until that cap
- **AND** if the cap fires first the diagnostic reason SHALL be `harness-timeout`
- **AND** SHALL NOT be `harness-background-wait`

### Requirement: Completed or failed jobs SHALL join within a versioned grace period

The pipeline SHALL require notification delivery and foreground-join within an effective grace
period after a supporting adapter emits typed completion or failure for a background job. The
pipeline SHALL own a versioned maximum join grace for `pipeline/background-job-lifecycle@1`. An
adapter MAY declare a tighter join grace and SHALL NOT declare a looser one. The effective grace
SHALL be the minimum of the pipeline maximum and the adapter declaration. `implementation_timeout`
SHALL remain the outer stage deadline and SHALL NOT be the join grace.

#### Scenario: Valid delivery and join inside grace succeeds

- **WHEN** a supporting adapter emits typed complete or fail for a job
- **AND** it emits notification delivery and foreground-join before the effective grace expires
- **THEN** the harness invocation SHALL NOT end as `harness-background-wait`
- **AND** SHALL NOT end as `harness-timeout` solely because the job ran in the background

#### Scenario: Missing delivery ends as harness-background-wait before the outer timeout

- **WHEN** a supporting adapter emits typed complete or fail for a job
- **AND** notification delivery does not occur before the effective grace expires
- **AND** the outer `implementation_timeout` has not yet fired
- **THEN** the pipeline SHALL terminate the wait as `harness-background-wait`
- **AND** SHALL NOT wait for the outer cap
- **AND** SHALL NOT report `harness-timeout`

#### Scenario: Missing foreground-join ends as harness-background-wait before the outer timeout

- **WHEN** a supporting adapter emits typed complete or fail and notification delivery for a job
- **AND** foreground-join does not occur before the effective grace expires
- **AND** the outer `implementation_timeout` has not yet fired
- **THEN** the pipeline SHALL terminate the wait as `harness-background-wait`
- **AND** SHALL NOT report `harness-timeout`

#### Scenario: An adapter cannot loosen the pipeline join maximum

- **WHEN** an adapter declares `background_job_lifecycle` supported with a join grace larger than
  the pipeline-owned versioned maximum
- **THEN** the effective grace SHALL be the pipeline-owned maximum
- **AND** conformance SHALL reject the declaration as incoherent

### Requirement: harness-background-wait SHALL carry bounded typed lifecycle evidence

When the pipeline emits `harness-background-wait`, the diagnostic SHALL include bounded typed
lifecycle evidence from the allowlist (adapter identity, invocation correlation, job identity,
timestamps, and state of the outstanding complete-or-fail-without-join). The diagnostic SHALL
NOT set the harness `timed_out` signal. Classification SHALL use the lifecycle evidence, not
free-form stderr or transcript matching.

#### Scenario: The closed reason is distinct from timeout

- **WHEN** a completed-but-unjoined job trips the join grace
- **THEN** the stage diagnostic `reason_code` SHALL be `harness-background-wait`
- **AND** the harness result SHALL NOT set `timed_out`
- **AND** the evidence SHALL name the job identity and state without raw command text

### Requirement: The same adapter SHALL NOT retry the same invocation fingerprint

After a `harness-background-wait` for an invocation fingerprint, the pipeline SHALL NOT
automatically retry that same adapter on that same fingerprint. Selecting a different adapter
SHALL require an existing explicit harness policy. The pipeline SHALL NOT add a hidden adapter
fallback for this class.

#### Scenario: Same-adapter retry is refused

- **WHEN** a mutating implementation invocation ends as `harness-background-wait`
- **AND** recovery or stage retry would reuse the same adapter and the same invocation
  fingerprint
- **THEN** the pipeline SHALL NOT spawn that retry
- **AND** SHALL retain the `harness-background-wait` outcome

#### Scenario: Existing explicit adapter policy is the only alternate-adapter path

- **WHEN** a configured harness policy already selects a different adapter for the stage
- **THEN** that existing policy MAY apply
- **AND** the pipeline SHALL NOT invent an additional fallback adapter for this class

### Requirement: Salvage SHALL run and the stage outcome SHALL remain harness-background-wait

The pipeline SHALL run the existing bounded salvage path and SHALL retain that salvage evidence
when a product-mutating harness ends as `harness-background-wait` and the worktree has
uncommitted salvageable work. The stage outcome SHALL remain `harness-background-wait`. Salvage
SHALL NOT convert the outcome into a successful stage, SHALL NOT open a pull request, SHALL NOT
transition the issue to `review-1`, and SHALL NOT reclassify the outcome as `harness-timeout`.
Publication and recovery of salvaged work remain outside this capability.

#### Scenario: Uncommitted work is salvaged without a successful-stage outcome

- **WHEN** a mutating implementation harness ends as `harness-background-wait`
- **AND** the worktree contains uncommitted salvageable changes
- **THEN** the pipeline SHALL create a salvage commit using the existing salvage path
- **AND** SHALL retain salvage evidence
- **AND** the stage outcome SHALL remain `harness-background-wait`
- **AND** SHALL NOT open a pull request or transition to `review-1`

#### Scenario: Clean worktree still reports harness-background-wait

- **WHEN** a mutating implementation harness ends as `harness-background-wait`
- **AND** the worktree has no salvageable uncommitted changes
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** the stage outcome SHALL still be `harness-background-wait`

### Requirement: Tests SHALL inject lifecycle event streams for the closed class

Unit tests SHALL inject adapter lifecycle event streams through a `deps` seam and SHALL NOT make
real network, git, or subprocess calls. The suite SHALL cover valid joins, legitimate
long-running jobs, completed-but-undelivered jobs, unjoined jobs, malformed or duplicate events,
capability refusal, bounded termination before the outer timeout, redaction, salvage, and no
same-adapter retry. Conformance fixtures SHALL represent historical Claude evidence from issue
`#547` and the new incident adapter provenance. An adapter whose raw protocol cannot prove
lifecycle state SHALL remain explicitly unsupported in those fixtures.

#### Scenario: Completed-but-undelivered fixture bites before the outer timeout

- **WHEN** a unit test injects typed complete without notification delivery
- **AND** the outer stage cap is larger than the effective join grace
- **THEN** the result SHALL be `harness-background-wait` before the outer cap
- **AND** the same fixture with the join-grace watchdog removed SHALL fail the assertion

#### Scenario: Historical non-proof protocols stay unsupported

- **WHEN** the conformance fixtures for the `#547` Claude evidence and the new incident adapter
  provenance are evaluated
- **THEN** each fixture SHALL declare `background_job_lifecycle` unsupported when its raw
  protocol cannot prove lifecycle state
- **AND** SHALL NOT mark that adapter supported solely because transcript text mentions a
  background test run

### Requirement: Production preflight SHALL refuse omitted or malformed required lifecycle and SHALL spawn explicit non-support

The pipeline SHALL treat an omitted or malformed required `background_job_lifecycle` declaration as a typed production-preflight `capability-refusal` for product-mutating implementation work. The pipeline SHALL NOT treat an explicit `supported: false` declaration as that refusal. Explicit non-support SHALL spawn the harness with the lifecycle supervisor disabled and SHALL NOT invent lifecycle events. When the adapter declares `supported: true` under a coherent schema, the pipeline SHALL keep the join-grace watchdog. This requirement SHALL NOT revert the #1364 compatibility contract.

#### Scenario: Explicit supported false remains spawn-allowed

- **WHEN** a mutating implementer stage assigns an adapter that declares `background_job_lifecycle.supported` as false
- **THEN** production preflight SHALL succeed this capability check
- **AND** the pipeline SHALL spawn the harness CLI
- **AND** the lifecycle supervisor SHALL stay disabled

#### Scenario: Omitted declaration remains capability-refusal

- **WHEN** a mutating implementer stage assigns an adapter that omits `background_job_lifecycle`
- **THEN** production preflight SHALL fail with `preflight_reason_code: capability-refusal`
- **AND** the pipeline SHALL NOT spawn the harness CLI

#### Scenario: Malformed declaration is capability-refusal

- **WHEN** a mutating implementer stage assigns an adapter whose `background_job_lifecycle` object fails the existing coherence contract
- **THEN** production preflight SHALL fail with `preflight_reason_code: capability-refusal`
- **AND** the pipeline SHALL NOT spawn the harness CLI
- **AND** the bounded message SHALL name the malformed field

#### Scenario: Supported true retains the watchdog

- **WHEN** a mutating implementer stage assigns an adapter that declares `background_job_lifecycle` supported under a coherent schema
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the join-grace watchdog SHALL remain enabled for that invocation
