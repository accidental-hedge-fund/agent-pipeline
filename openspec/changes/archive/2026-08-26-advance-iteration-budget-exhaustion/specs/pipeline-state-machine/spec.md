## ADDED Requirements

### Requirement: Non-terminal MAX_ITERATIONS exhaustion SHALL be an incomplete invocation

The orchestrator SHALL treat a per-invocation `MAX_ITERATIONS` fall-out as an incomplete run when the issue is not at `ready-to-deploy`. This requirement augments the "Bounded advance loop" cap: the loop still stops after at most 12 transitions, and this requirement names the operator-visible and machine-visible outcome of that stop at a non-terminal stage.

When the loop exits because the iteration cap is exhausted and the final stage is not `ready-to-deploy` and not `needs-human`, the run SHALL NOT print the ordinary `done — <start> → <stage> (N transitions, …)` completion summary. The run SHALL print a distinct line of the form `iteration budget exhausted at <stage>; re-run pipeline <N> to continue` (stage and issue number filled in). The process exit code SHALL be non-zero. The run SHALL NOT present the invocation as a successful terminal stop.

A legitimate non-advancing stop inside the loop (`blocked`, `waiting`, `no-op`, `finalized`, `error`, `--once`, label removed) SHALL keep its existing stop semantics, including a non-error end on `waiting`. This requirement applies only when the `for` loop completes because the iteration cap is reached, not when the loop `break`s on a stage outcome.

This requirement SHALL NOT raise or configure `MAX_ITERATIONS`. It SHALL NOT change in-loop `auto_loop` continuation or in-loop auto-loop budget-exhaustion park (`autoLoopExhaustedBlockedOutcome` + auto-loop exhausted comment). The new handler SHALL run only when the `for` loop falls through the iteration cap (`iterationBudgetExhausted === true`). An in-loop auto-loop exhaustion `break` SHALL NOT enter this handler and SHALL NOT be double-parked. If auto-loop `continue`s on the last iteration slot and the `for` condition then fails, that SHALL be iteration-budget exhaustion (not auto-loop budget exhaustion) and SHALL NOT post an auto-loop exhausted comment. This requirement SHALL NOT merge.

#### Scenario: budget death at pre-merge is not a successful done summary

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` and the final stage is `pre-merge`
- **AND** `auto_loop` is not enabled
- **THEN** the run SHALL NOT print `done — <start> → pre-merge (N transitions, …)`
- **AND** the run SHALL print `iteration budget exhausted at pre-merge; re-run pipeline <N> to continue`
- **AND** the process exit code SHALL be non-zero

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
- **THEN** the run SHALL keep the existing auto-loop exhausted park and comment
- **AND** the run SHALL NOT print the iteration-budget exhausted line
- **AND** the run SHALL NOT apply a second park from this requirement

### Requirement: Pre-merge iteration-budget exhaustion SHALL park with ci-exhausted and release a safe worktree

When `MAX_ITERATIONS` is exhausted and the final stage is `pre-merge`, the orchestrator SHALL materialize a blocked outcome whose blocker kind is `ci-exhausted` (the existing pre-merge mechanical shape that projects to `implementation-ci`, not a human-authority hold). The block reason SHALL name iteration-budget exhaustion. The run SHALL apply that block on the issue (unless `--dry-run`) and SHALL attempt the existing durable park-release of a safe managed worktree so capacity is not stranded.

The orchestrator SHALL reuse the existing pre-merge exhaustion kind mapping (`ci-exhausted`, offramp class `ci-failed` when that mapping already emits it), extracted so `autoLoopExhaustedBlockedOutcome` keeps its auto-loop reason. It SHALL NOT add a new `BlockerKind`. It SHALL NOT copy an `auto-loop budget exhausted` reason prefix onto this path: `auto_loop` is not the budget that died. After applying the block, `run_complete.final_state` SHALL remain the pre-park stage `pre-merge` (not `blocked`).

Other non-terminal stages (`review-*`, `fix-*`, `visual-gate`, `eval-gate`, `shipcheck-gate`, and earlier stages) SHALL receive the incomplete-invocation treatment of the previous requirement and SHALL NOT be required to park with `ci-exhausted`.

#### Scenario: pre-merge budget death materializes ci-exhausted and park-release

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at `pre-merge` with `auto_loop` disabled and without `--dry-run`
- **THEN** the run SHALL set the issue blocked with kind `ci-exhausted`
- **AND** the block reason SHALL name iteration-budget exhaustion
- **AND** the run SHALL attempt durable park-release of the issue's managed worktree (release when safety preconditions hold; retain with a visible reason otherwise)

#### Scenario: review-1 budget death does not invent a pre-merge CI block

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at `review-1` with `auto_loop` disabled
- **THEN** the run SHALL apply the incomplete-invocation treatment
- **AND** the run SHALL NOT set blocker kind `ci-exhausted` for that stage

### Requirement: Ready-to-deploy deferred finalize SHALL remain when the iteration cap is exhausted at ready-to-deploy

When the advance loop exhausts `MAX_ITERATIONS` and the final stage is `ready-to-deploy` without having already run terminal finalize in-loop, the orchestrator SHALL still run `deploy_ready.finalize` after the loop: tag the linked PR `pipeline:ready-to-deploy`, post the existing final summary, and remove the managed worktree according to existing finalize rules. The orchestrator SHALL NOT apply the non-terminal incomplete-invocation treatment (exhausted line, non-zero exit, `ci-exhausted` park) to that ready-to-deploy path.

#### Scenario: iteration cap at ready-to-deploy still finalizes

- **WHEN** the loop exhausts `MAX_ITERATIONS` with final stage `ready-to-deploy` and terminal finalize has not already run in-loop
- **AND** the run is not `--dry-run`
- **THEN** the run SHALL still finalize (PR tagged `pipeline:ready-to-deploy`, existing summary posted)
- **AND** the run SHALL NOT print `iteration budget exhausted at ready-to-deploy; re-run pipeline <N> to continue` as the replacement for finalize
- **AND** the advance loop SHALL NOT merge the PR

### Requirement: Non-terminal iteration-budget exhaustion regressions SHALL fail the unit suite

The unit suite SHALL include injected tests (no live network, git, or subprocess) that fail if non-terminal `MAX_ITERATIONS` exhaustion is treated as a successful completion. One test SHALL fail if an exhausted loop at `pre-merge` or `review-1` with `auto_loop` disabled exits 0, prints the ordinary `done —` summary, and sets no blocker. A second test SHALL fail if the pre-merge budget-death path does not materialize `ci-exhausted` and does not attempt worktree park-release.

#### Scenario: pre-merge or review-1 silent success fails the suite

- **WHEN** a unit test injects an advance loop that exhausts `MAX_ITERATIONS` at `pre-merge` or `review-1` with `auto_loop` disabled
- **AND** the run exits 0, prints `done — <start> → <stage> (N transitions, …)`, and sets no blocker
- **THEN** that test SHALL fail

#### Scenario: pre-merge path without ci-exhausted park-release fails the suite

- **WHEN** a unit test injects an advance loop that exhausts `MAX_ITERATIONS` at `pre-merge` with `auto_loop` disabled
- **AND** the run does not materialize blocker kind `ci-exhausted` or does not attempt worktree park-release
- **THEN** that test SHALL fail
