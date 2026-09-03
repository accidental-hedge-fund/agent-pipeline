## MODIFIED Requirements

### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

`needs-spec` SHALL sit between `backlog` and `ready`. It is an admission hold, not a delivery stage: the orchestrator SHALL NOT start planning or implementation from it. Dispatch SHALL wait the way `backlog` waits. It SHALL NOT be a member of `TERMINAL_STAGES`. Gate behavior is specified by the `issue-implementation-readiness-gate` capability.

`pre-code-attestation` (#575) SHALL sit between `plan-review` and `implementing`. It is always
present in the graph, but it is inert unless `pre_code_attestation.enabled` is true and a risk
trigger matches: when disabled or untriggered it SHALL advance toward `implementing` with a
recorded reason and without a human attestation hold. Gate behavior is specified by the
`pre-code-attestation` and `pre-code-design-dossier` capabilities. It SHALL NOT replace
`plan-review` or `design-gate`.

`design-gate` (#436) SHALL sit between `implementing` and `review-1`. It is always traversed, but it is
inert unless the design-interrogation gate is enabled and a risk trigger matches: when disabled or
untriggered it SHALL advance immediately to `review-1` with a recorded reason and no harness call. Its
gate behavior is specified by the `design-interrogation-gate` capability.

`needs-human` SHALL appear in `STAGES` as the compatibility off-ramp entry (after `ready-to-deploy` in the
constant order). It is not a happy-path successor of `ready-to-deploy`. It SHALL project a current
typed-input wait (`DecisionRequest`, `CapabilityRequest`, or `AuthorityRequest`). Mechanical
exhaustion, unknown failure, malformed output, process death, no progress, capacity, and retry
exhaustion SHALL NOT enter `needs-human` as human ownership. Its resume and status
surfaces are specified by the `needs-human-status-surface`, override-related, and
`recovery-lifecycle-ownership` capabilities.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `needs-spec`, `ready`, `planning`, `plan-review`, `pre-code-attestation`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`, `needs-human`
- **AND** `needs-spec` SHALL appear at an index greater than `backlog` and less than `ready`
- **AND** `pre-code-attestation` SHALL appear at an index greater than `plan-review` and less than `implementing`
- **AND** `design-gate` SHALL appear at an index greater than `implementing` and less than `review-1`
- **AND** `visual-gate` SHALL appear at an index greater than `pre-merge` and less than `eval-gate`
- **AND** `eval-gate` SHALL appear at an index greater than `visual-gate` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`
- **AND** `needs-human` SHALL appear after `ready-to-deploy` in the constant order
- **AND** `needs-human` SHALL be a member of `TERMINAL_STAGES`
- **AND** `needs-spec` SHALL NOT be a member of `TERMINAL_STAGES`

#### Scenario: dispatch routes needs-spec as a wait
- **WHEN** the current stage label is `pipeline:needs-spec`
- **THEN** the orchestrator SHALL NOT invoke planning or implementation
- **AND** SHALL NOT create a worktree
- **AND** the outcome SHALL be a non-advancing wait that tells the operator to apply a spec and re-admit with `pipeline triage <N> --stage ready`

#### Scenario: dispatch routes pre-code-attestation
- **WHEN** the current stage label is `pipeline:pre-code-attestation`
- **THEN** the orchestrator SHALL call the pre-code attestation stage handler
- **AND** SHALL NOT call the implementing handler in the same transition until the stage advances

#### Scenario: disabled pre-code-attestation is a no-op pass-through
- **WHEN** the current stage is `pre-code-attestation` and `cfg.pre_code_attestation.enabled` is `false`
- **THEN** the issue SHALL transition toward `implementing` in the same run
- **AND** no human attestation SHALL be required by this stage

#### Scenario: dispatch routes design-gate
- **WHEN** the current stage label is `pipeline:design-gate`
- **THEN** the orchestrator SHALL call the design-gate stage handler
- **AND** SHALL NOT call any review or `deployReady.finalize()` handler directly

#### Scenario: design-gate is a no-op when the gate is disabled
- **WHEN** the current stage is `design-gate` and `cfg.design_gate.enabled` is `false`
- **THEN** the issue SHALL transition to `review-1` in the same run
- **AND** no harness SHALL be invoked by the stage

#### Scenario: dispatch routes visual-gate
- **WHEN** the current stage label is `pipeline:visual-gate`
- **THEN** the orchestrator SHALL call the visual stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: dispatch routes eval-gate
- **WHEN** the current stage label is `pipeline:eval-gate`
- **THEN** the orchestrator SHALL call the eval stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: dispatch routes shipcheck-gate
- **WHEN** the current stage label is `pipeline:shipcheck-gate`
- **THEN** the orchestrator SHALL call the shipcheck stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: mechanical exhaustion does not enter needs-human
- **WHEN** review-ceiling, auto-loop, or retry budget is exhausted without current typed-request evidence
- **THEN** the orchestrator SHALL NOT transition the issue to `pipeline:needs-human` as human ownership
- **AND** RecoverySupervisor SHALL retain ownership as Cooling or an external-condition wait

---

### Requirement: Terminal stages are ready-to-deploy and needs-human
`TERMINAL_STAGES` SHALL be exactly the set `{ready-to-deploy, needs-human}`. That set is the label-inventory terminal for advance-loop dispatch. Both members stop the current advance invocation; neither is followed by another stage handler dispatch, and neither merges the PR.

When an issue reaches `ready-to-deploy`, the run finalizes the happy path (tagging the PR `pipeline:ready-to-deploy` and posting a summary) and the advance loop stops. That label terminal SHALL coincide with lifecycle `succeeded` for the advance Logical Operation only after the declared observer proves the ready-to-deploy postcondition.

When an issue reaches `needs-human`, the advance loop SHALL stop the current invocation. That label SHALL project a current typed-input wait. The item SHALL remain RecoverySupervisor-owned. The item SHALL never auto-advance from `needs-human` to `ready-to-deploy`. Mechanical exhaustion SHALL NOT use this label as human ownership.

#### Scenario: reaching the ready-to-deploy terminal stage
- **WHEN** an issue advances to `ready-to-deploy`
- **THEN** the run SHALL finalize (tagging the PR `pipeline:ready-to-deploy` and posting a summary) and stop
- **AND** no further stage handler SHALL be dispatched
- **AND** the PR SHALL NOT be merged by the advance loop

#### Scenario: reaching the needs-human terminal stage
- **WHEN** an issue reaches `needs-human` because a current typed request exists
- **THEN** the advance loop SHALL stop the current invocation
- **AND** no further stage handler SHALL be dispatched to auto-advance toward `ready-to-deploy`
- **AND** the PR SHALL NOT be merged by the advance loop
- **AND** RecoverySupervisor SHALL retain ownership as `typed-input-wait`

#### Scenario: TERMINAL_STAGES membership
- **WHEN** the `TERMINAL_STAGES` constant is inspected
- **THEN** it SHALL contain exactly `ready-to-deploy` and `needs-human`
- **AND** it SHALL NOT omit `needs-human`
- **AND** it SHALL NOT contain any other stage name

#### Scenario: needs-human label is not lifecycle cancellation
- **WHEN** the advance loop stops because the issue label is `pipeline:needs-human`
- **THEN** that process stop SHALL NOT mark the Logical Operation `cancelled` or `succeeded`
- **AND** SHALL NOT grant human authority without a current typed request

---

### Requirement: Bounded advance loop
The orchestrator SHALL advance at most `MAX_ITERATIONS` (= 12) transitions per invocation. Each iteration dispatches the current stage and either advances (incrementing a transition count) or stops on a non-advancing outcome (`blocked`, `waiting`, `no-op`, `finalized`, or `error`). Under `--once`, it SHALL stop after a single transition. That process stop SHALL NOT end RecoverySupervisor ownership of the Logical Operation.

#### Scenario: loop stops on a waiting outcome
- **WHEN** a stage returns `{ advanced: false, status: "waiting" }` (e.g. CI still running)
- **THEN** the loop SHALL break and the run SHALL end without error, to be resumed on a later invocation
- **AND** RecoverySupervisor SHALL retain ownership as Cooling or an external-condition wait

#### Scenario: iteration cap
- **WHEN** stages keep advancing without reaching a terminal/blocked state
- **THEN** the loop SHALL stop after at most 12 transitions in a single invocation
- **AND** RecoverySupervisor SHALL retain ownership as Cooling

---

### Requirement: Blocked state halts the advance loop

When an issue carries the `blocked` label (`BLOCKED_LABEL = "blocked"`), the advance loop SHALL stop the current invocation and surface the latest blocker comment — except at `implementing`, where auto-recovery is attempted first; if recovery succeeds the loop continues, otherwise it stops. The "## Pipeline: Blocked" comment posted by `setBlocked` SHALL render a kind-specific "### How to unblock" section drawn from the `BlockerKind` enum and the `BLOCKER_RECIPES` map; the section SHALL NOT use the generic `--unblock` instruction for blocker classes where `--unblock` is not the correct recovery verb. The `blocked` label SHALL be a compatibility projection. It SHALL NOT by itself be lifecycle, scheduler, or authority truth. RecoverySupervisor SHALL retain ownership unless a current typed request or verified success or authenticated cancellation applies.

When an issue at `implementing` is **not** blocked but the dispatch table is entered at that stage (re-entry at the start of a run), the pipeline SHALL check for a resumable worktree before returning "nothing to do" — see the `implementing-resume` capability.

#### Scenario: blocked issue stops the loop

- **WHEN** the current issue carries the `blocked` label at `review-1`
- **THEN** the loop SHALL stop and surface the blocker rather than dispatching the stage
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: blocked comment contains kind-specific recipe

- **WHEN** `setBlocked` is called with `kind = "test-gate-exhausted"`
- **THEN** the posted GitHub comment SHALL contain the test-gate-exhausted recipe text under "### How to unblock"
- **AND** the section SHALL NOT instruct the operator to run `--unblock`

#### Scenario: implementing dispatch with commits — resumes rather than waits

- **WHEN** the advance loop dispatches stage `implementing` at the start of a run (re-entry)
- **AND** the issue does NOT carry the `blocked` label
- **AND** a worktree with commits ahead of the base branch exists for the issue
- **THEN** the dispatcher SHALL invoke the implementing-resume path rather than returning `{ status: "waiting" }`

#### Scenario: blocked label is not human authority

- **WHEN** the issue carries `blocked` without a current typed request
- **THEN** the advance loop MAY stop the current invocation
- **AND** SHALL NOT treat that label as `typed-input-wait` or cancellation

---

### Requirement: Non-terminal MAX_ITERATIONS exhaustion SHALL be an incomplete invocation

The orchestrator SHALL treat a per-invocation `MAX_ITERATIONS` fall-out as an incomplete run when the issue is not at `ready-to-deploy`. This requirement augments the "Bounded advance loop" cap: the loop still stops after at most 12 transitions, and this requirement names the operator-visible and machine-visible outcome of that stop at a non-terminal stage.

When the loop exits because the iteration cap is exhausted and the final stage is not `ready-to-deploy` and not `needs-human`, the run SHALL NOT print the ordinary `done — <start> → <stage> (N transitions, …)` completion summary. The run SHALL print a distinct line of the form `iteration budget exhausted at <stage>; re-run pipeline <N> to continue` (stage and issue number filled in). The process exit code SHALL be non-zero. The run SHALL NOT present the invocation as a successful terminal stop. RecoverySupervisor SHALL retain ownership as Cooling. The iteration cap SHALL NOT create `typed-input-wait`, human ownership, or cancellation.

A legitimate non-advancing stop inside the loop (`blocked`, `waiting`, `no-op`, `finalized`, `error`, `--once`, label removed) SHALL keep its existing stop semantics, including a non-error end on `waiting`. This requirement applies only when the `for` loop completes because the iteration cap is reached, not when the loop `break`s on a stage outcome.

This requirement SHALL NOT raise or configure `MAX_ITERATIONS`. It SHALL NOT change in-loop `auto_loop` continuation. In-loop auto-loop budget exhaustion SHALL enter Cooling rather than human-owned `needs-human` (`autoLoopExhaustedBlockedOutcome` remains a compatibility blocked projection). The new handler SHALL run only when the `for` loop falls through the iteration cap (`iterationBudgetExhausted === true`). An in-loop auto-loop exhaustion `break` SHALL NOT enter this handler and SHALL NOT be double-parked. If auto-loop `continue`s on the last iteration slot and the `for` condition then fails, that SHALL be iteration-budget exhaustion (not auto-loop budget exhaustion) and SHALL NOT post an auto-loop exhausted comment. This requirement SHALL NOT merge.

#### Scenario: budget death at pre-merge is not a successful done summary

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` and the final stage is `pre-merge`
- **AND** `auto_loop` is not enabled
- **THEN** the run SHALL NOT print `done — <start> → pre-merge (N transitions, …)`
- **AND** the run SHALL print `iteration budget exhausted at pre-merge; re-run pipeline <N> to continue`
- **AND** the process exit code SHALL be non-zero
- **AND** RecoverySupervisor SHALL retain ownership as Cooling

#### Scenario: budget death at review-1 is not a successful done summary

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` and the final stage is `review-1`
- **AND** `auto_loop` is not enabled
- **THEN** the run SHALL NOT print `done — <start> → review-1 (N transitions, …)`
- **AND** the run SHALL print `iteration budget exhausted at review-1; re-run pipeline <N> to continue`
- **AND** the process exit code SHALL be non-zero
- **AND** the run SHALL NOT require a new `BlockerKind` for this stage

#### Scenario: in-loop waiting stop is unchanged

- **WHEN** a stage returns `{ advanced: false, status: "waiting" }` before the iteration cap is reached
- **THEN** the loop SHALL break and the run SHALL end without this incomplete-invocation treatment
- **AND** the run SHALL NOT print the iteration-budget exhausted line solely because of that waiting stop

#### Scenario: waiting break on the last iteration slot is not exhaustion

- **WHEN** the loop is on the last `MAX_ITERATIONS` slot
- **AND** the stage returns `{ advanced: false, status: "waiting" }` so the loop `break`s
- **THEN** the run SHALL end without this incomplete-invocation treatment
- **AND** the process exit code SHALL NOT be set non-zero solely because that waiting stop used the last slot

#### Scenario: in-loop auto-loop exhaustion is unchanged

- **WHEN** `auto_loop` is enabled and the in-loop auto-loop budget is exhausted so the loop `break`s after `autoLoopExhaustedBlockedOutcome`
- **THEN** RecoverySupervisor SHALL retain ownership as Cooling
- **AND** the run SHALL NOT print the iteration-budget exhausted line
- **AND** the run SHALL NOT apply a second park from this requirement
- **AND** the run SHALL NOT create human-owned `needs-human` solely for that auto-loop budget

---

### Requirement: Pre-merge iteration-budget exhaustion SHALL park with ci-exhausted and release a safe worktree

When `MAX_ITERATIONS` is exhausted and the final stage is `pre-merge`, the orchestrator SHALL materialize a blocked outcome whose blocker kind is `ci-exhausted` (the existing pre-merge mechanical shape that projects to `implementation-ci`, not a human-authority hold). The block reason SHALL name iteration-budget exhaustion. The run SHALL apply that block on the issue (unless `--dry-run`) and SHALL attempt the existing durable park-release of a safe managed worktree so capacity is not stranded. RecoverySupervisor SHALL retain ownership as Cooling. The `ci-exhausted` projection SHALL NOT create `typed-input-wait` or cancellation.

The orchestrator SHALL reuse the existing pre-merge exhaustion kind mapping (`ci-exhausted`, offramp class `ci-failed` when that mapping already emits it), extracted so `autoLoopExhaustedBlockedOutcome` keeps its auto-loop reason. It SHALL NOT add a new `BlockerKind`. It SHALL NOT copy an `auto-loop budget exhausted` reason prefix onto this path: `auto_loop` is not the budget that died. After applying the block, `run_complete.final_state` SHALL remain the pre-park stage `pre-merge` (not `blocked`).

Other non-terminal stages (`review-*`, `fix-*`, `visual-gate`, `eval-gate`, `shipcheck-gate`, and earlier stages) SHALL receive the incomplete-invocation treatment of the previous requirement and SHALL NOT be required to park with `ci-exhausted`.

#### Scenario: pre-merge budget death materializes ci-exhausted and park-release

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at `pre-merge` with `auto_loop` disabled and without `--dry-run`
- **THEN** the run SHALL set the issue blocked with kind `ci-exhausted`
- **AND** the block reason SHALL name iteration-budget exhaustion
- **AND** the run SHALL attempt durable park-release of the issue's managed worktree (release when safety preconditions hold; retain with a visible reason otherwise)
- **AND** RecoverySupervisor SHALL retain ownership as Cooling

#### Scenario: review-1 budget death does not invent a pre-merge CI block

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at `review-1` with `auto_loop` disabled
- **THEN** the run SHALL apply the incomplete-invocation treatment
- **AND** the run SHALL NOT set blocker kind `ci-exhausted` for that stage
