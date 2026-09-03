## MODIFIED Requirements

### Requirement: Human checkpoints and override/sandbox settings are hard constraints the budget cannot override

The auto-loop SHALL treat a current typed-input wait (`DecisionRequest`, `CapabilityRequest`, or
`AuthorityRequest`), including a compatibility `needs-human` projection of that wait, and the
plan-review human-feedback gate (#23) as hard stops: it SHALL stop immediately and SHALL NOT
continue past them regardless of remaining round or wall-clock budget. Mechanical exhaustion,
unknown failure, and retry exhaustion SHALL NOT satisfy this hard-stop predicate. Auto-loop fix
rounds SHALL honor the active `review_policy` block thresholds and recorded `--override`
dispositions, and auto-loop harness invocations SHALL honor the resolved `harness_sandbox` setting.

#### Scenario: needs-human stops the loop with budget remaining

- **WHEN** the auto-loop is active with rounds and wall-clock budget remaining
- **AND** a stage produces a current typed request that projects to `needs-human`
- **THEN** the loop SHALL stop immediately and SHALL NOT auto-continue past that typed-input wait

#### Scenario: plan-review human gate is respected

- **WHEN** the auto-loop is active and the run is waiting on the plan-review human-feedback checkpoint (#23)
- **THEN** the loop SHALL NOT bypass that checkpoint, regardless of remaining budget

#### Scenario: override and sandbox settings honored

- **WHEN** an auto-loop continuation invokes a fix or review stage
- **THEN** it SHALL apply the active `review_policy` thresholds and any recorded `--override` dispositions
- **AND** any harness invocation SHALL use the resolved `harness_sandbox` mode

#### Scenario: mechanical exhaustion is not this hard stop

- **WHEN** the auto-loop exhausts round or wall-clock budget without a current typed request
- **THEN** this hard-stop predicate SHALL NOT treat that exhaustion as human-owned `needs-human`
- **AND** RecoverySupervisor SHALL retain ownership as Cooling

---

### Requirement: Recurrence detection bounds auto-loop churn

The auto-loop SHALL integrate the `review-loop-recurrence` early-park (#133): when a blocking finding recurs after an auto-loop fix round (its `findingKey` matches a blocking key in the immediately-prior Review-N comment), the pipeline SHALL enter Cooling for that item and the auto-loop SHALL NOT re-spend round or wall-clock budget to retry that recurring finding. A recurring finding therefore cannot churn the auto-loop to its budget ceiling. Recurrence SHALL NOT create human-owned `needs-human` unless the shared classifier emits a current typed request.

#### Scenario: recurring finding early-parks instead of consuming budget

- **WHEN** the auto-loop performs a fix round and the subsequent review round re-emits a blocking finding whose `findingKey` matches a blocking key from the immediately-prior Review-N comment
- **THEN** RecoverySupervisor SHALL enter Cooling for that item
- **AND** the auto-loop SHALL NOT perform a further continuation to retry that finding
- **AND** the pipeline SHALL NOT park as human-owned `needs-human` solely for that recurrence

#### Scenario: only genuinely new findings consume budget

- **WHEN** an auto-loop fix round resolves the prior finding and the next round surfaces a different finding (a new `findingKey`)
- **THEN** the auto-loop MAY continue within remaining budget, treating it as new work rather than a recurrence

---

### Requirement: Budget exhaustion parks at needs-human with an evidence-backed handoff

When the auto-loop cannot perform a further continuation because `max_rounds` or `max_wallclock_minutes` is exhausted, RecoverySupervisor SHALL enter Cooling for that item and SHALL post a concise, evidence-backed handoff: what recovery was attempted, what remains unresolved, and how much budget was consumed (rounds used / wall-clock used). That handoff SHALL be an observation, not human authority. The pipeline SHALL NOT transition the issue to human-owned `needs-human` solely for that budget. Resuming SHALL follow Cooling wake or operator `--resume` / `--override` only when a later typed request or governed override exists.

#### Scenario: round budget exhausted parks with handoff

- **WHEN** the auto-loop has consumed all `max_rounds` and a further recoverable stop occurs
- **THEN** RecoverySupervisor SHALL enter Cooling
- **AND** SHALL post a handoff stating what was attempted, what remains, and the budget consumed
- **AND** SHALL NOT auto-advance
- **AND** SHALL NOT create human-owned `needs-human` solely for that budget

#### Scenario: needs-human park is resumable via the existing path

- **WHEN** an operator resumes an auto-loop budget-exhaustion Cooling state
- **THEN** RecoverySupervisor SHALL retain ownership
- **AND** resume SHALL NOT require a fabricated typed request
- **AND** existing `--override` SHALL apply only to a later current typed request or governed finding disposition
