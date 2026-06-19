# bounded-auto-loop Specification

## Purpose
TBD - created by archiving change bounded-auto-loop. Update Purpose after archive.
## Requirements
### Requirement: The bounded auto-loop is opt-in and default-disabled

The bounded auto-loop SHALL be governed by an `auto_loop` config block whose `enabled` field defaults to `false`. When `auto_loop` is absent from `.github/pipeline.yml` or `auto_loop.enabled` is `false`, the advance loop SHALL behave identically to the baseline `pipeline-state-machine` "Bounded advance loop" requirement: it stops on `blocked`, `waiting`, `no-op`, `finalized`, or `error`, and performs no automatic continuation. This requirement augments the bounded advance loop; it SHALL NOT change the `MAX_ITERATIONS` per-invocation cap, the terminal stage, or the never-auto-merge structural guarantee.

#### Scenario: auto_loop absent — behavior unchanged

- **WHEN** `.github/pipeline.yml` does not set an `auto_loop` block
- **THEN** the advance loop SHALL stop on a `waiting` or recoverable `blocked` outcome exactly as the baseline bounded advance loop does
- **AND** SHALL perform no automatic continuation

#### Scenario: auto_loop disabled — behavior unchanged

- **WHEN** `auto_loop.enabled` is `false`
- **THEN** the resolved continuation behavior SHALL be identical to the `auto_loop`-absent case

### Requirement: Recoverable stops at allowlisted stages convert to bounded continuations

When `auto_loop.enabled` is `true` and the advance loop reaches a non-advancing outcome that is **recoverable** (a `waiting` outcome, or a `blocked` outcome whose `BlockerKind` has a pipeline-owned recovery recipe) at a stage present in `auto_loop.stages`, the loop SHALL — instead of breaking — perform the existing pipeline-owned recovery (e.g. CI/test rerun, stale-branch rebase, reviewer/shipcheck finding fix) and continue, provided budget remains. A recoverable stop at a stage **not** in `auto_loop.stages`, and any non-recoverable outcome (`no-op`, `finalized`, `error`, or a `blocked` kind with no recovery recipe), SHALL stop the loop exactly as the baseline does.

The auto-loop SHALL only retry or fix work within existing pipeline-owned stages. It SHALL NOT introduce new stages, expand the issue's scope beyond the finding/failure being recovered, merge, deploy, publish, or take any action outside the reviewed change.

#### Scenario: recoverable stop at an allowlisted stage continues

- **WHEN** `auto_loop.enabled` is `true`, `auto_loop.stages` includes `eval-gate`, budget remains, and the `eval-gate` stage returns a recoverable `waiting`/`blocked` outcome (e.g. a flaky test rerun is available)
- **THEN** the loop SHALL perform the pipeline-owned recovery and continue rather than breaking

#### Scenario: recoverable stop at a non-allowlisted stage still stops

- **WHEN** `auto_loop.enabled` is `true` but the recoverable stop occurs at a stage NOT present in `auto_loop.stages`
- **THEN** the loop SHALL break and surface the outcome, identical to the baseline behavior

#### Scenario: non-recoverable outcome always stops

- **WHEN** `auto_loop.enabled` is `true` and a stage returns `error`, or a `blocked` outcome whose `BlockerKind` has no pipeline-owned recovery recipe
- **THEN** the loop SHALL stop regardless of remaining budget and SHALL NOT attempt an automatic continuation

#### Scenario: auto-loop never expands scope or merges

- **WHEN** the auto-loop performs any continuation
- **THEN** it SHALL NOT call any merge/deploy/publish surface and SHALL NOT modify code outside the scope of the finding or failure being recovered

### Requirement: Round and wall-clock budgets bound automatic continuations

The auto-loop SHALL consume one unit of `auto_loop.max_rounds` for each automatic continuation it performs, and SHALL track elapsed wall-clock against `auto_loop.max_wallclock_minutes` using an injected clock seam so unit tests perform no real time or I/O. Before performing a continuation, the loop SHALL check that at least one round remains AND that the wall-clock budget is not exhausted. When either budget would be exceeded, the loop SHALL NOT perform a further continuation. These budgets are independent of, and composed with, the existing `review_policy.max_adversarial_rounds` cap (which continues to bound review re-runs within a round).

#### Scenario: round budget decrements per continuation

- **WHEN** the auto-loop performs an automatic continuation
- **THEN** the remaining `max_rounds` budget SHALL decrease by exactly one

#### Scenario: wall-clock budget blocks a further continuation

- **WHEN** a recoverable stop occurs at an allowlisted stage, rounds remain, but the elapsed wall-clock has reached `max_wallclock_minutes`
- **THEN** the loop SHALL NOT perform the continuation and SHALL park (see budget-exhaustion handoff)

#### Scenario: review round cap is unchanged

- **WHEN** the auto-loop continues into a review stage
- **THEN** the number of review re-runs within that stage SHALL still be bounded by `review_policy.max_adversarial_rounds`, unchanged by the auto-loop budget

### Requirement: Human checkpoints and override/sandbox settings are hard constraints the budget cannot override

The auto-loop SHALL treat `needs-human` (whether reached via the review ceiling, the `ceiling_action`, or the review-loop-recurrence early-park) and the plan-review human-feedback gate (#23) as hard stops: it SHALL stop immediately and SHALL NOT continue past them regardless of remaining round or wall-clock budget. Auto-loop fix rounds SHALL honor the active `review_policy` block thresholds and recorded `--override` dispositions, and auto-loop harness invocations SHALL honor the resolved `harness_sandbox` setting.

#### Scenario: needs-human stops the loop with budget remaining

- **WHEN** the auto-loop is active with rounds and wall-clock budget remaining
- **AND** a stage transitions the issue to `needs-human`
- **THEN** the loop SHALL stop immediately and SHALL NOT auto-continue past `needs-human`

#### Scenario: plan-review human gate is respected

- **WHEN** the auto-loop is active and the run is waiting on the plan-review human-feedback checkpoint (#23)
- **THEN** the loop SHALL NOT bypass that checkpoint, regardless of remaining budget

#### Scenario: override and sandbox settings honored

- **WHEN** an auto-loop continuation invokes a fix or review stage
- **THEN** it SHALL apply the active `review_policy` thresholds and any recorded `--override` dispositions
- **AND** any harness invocation SHALL use the resolved `harness_sandbox` mode

### Requirement: Recurrence detection bounds auto-loop churn

The auto-loop SHALL integrate the `review-loop-recurrence` early-park (#133): when a blocking finding recurs after an auto-loop fix round (its `findingKey` matches a blocking key in the immediately-prior Review-N comment), the pipeline SHALL early-park at `needs-human` and the auto-loop SHALL NOT re-spend round or wall-clock budget to retry that recurring finding. A recurring finding therefore cannot churn the auto-loop to its budget ceiling.

#### Scenario: recurring finding early-parks instead of consuming budget

- **WHEN** the auto-loop performs a fix round and the subsequent review round re-emits a blocking finding whose `findingKey` matches a blocking key from the immediately-prior Review-N comment
- **THEN** the pipeline SHALL early-park at `needs-human` per `review-loop-recurrence`
- **AND** the auto-loop SHALL NOT perform a further continuation to retry that finding

#### Scenario: only genuinely new findings consume budget

- **WHEN** an auto-loop fix round resolves the prior finding and the next round surfaces a different finding (a new `findingKey`)
- **THEN** the auto-loop MAY continue within remaining budget, treating it as new work rather than a recurrence

### Requirement: Each automatic continuation records its rationale and remaining budget

For each automatic continuation, the auto-loop SHALL record why it continued (the recoverable class / stage) and the remaining budget (rounds remaining and wall-clock remaining). This record SHALL be written to the evidence bundle as a recovery/continuation event and surfaced on the run (a posted or updated comment line). The recording SHALL be non-fatal: a failure to write the record SHALL NOT abort the run.

#### Scenario: continuation event written to the evidence bundle

- **WHEN** the auto-loop performs an automatic continuation
- **THEN** the evidence bundle SHALL gain a continuation record naming the recoverable class/stage, the rounds remaining, and the wall-clock remaining

#### Scenario: recording failure is non-fatal

- **WHEN** writing the continuation record fails
- **THEN** the auto-loop SHALL continue without aborting the run

### Requirement: Budget exhaustion parks at needs-human with an evidence-backed handoff

When the auto-loop cannot perform a further continuation because `max_rounds` or `max_wallclock_minutes` is exhausted, the pipeline SHALL transition the issue to `needs-human` and post a concise, evidence-backed handoff: what recovery was attempted, what remains unresolved, and how much budget was consumed (rounds used / wall-clock used). This park SHALL be identical in authority to the ceiling-triggered `needs-human` park — it SHALL NOT auto-advance, and resuming SHALL follow the existing `--override` / needs-human resume path.

#### Scenario: round budget exhausted parks with handoff

- **WHEN** the auto-loop has consumed all `max_rounds` and a further recoverable stop occurs
- **THEN** the pipeline SHALL transition to `needs-human`
- **AND** SHALL post a handoff stating what was attempted, what remains, and the budget consumed
- **AND** SHALL NOT auto-advance

#### Scenario: needs-human park is resumable via the existing path

- **WHEN** an operator resumes an auto-loop budget-exhaustion park
- **THEN** the existing `needs-human` resume behavior (e.g. `--override`) SHALL apply, unchanged

