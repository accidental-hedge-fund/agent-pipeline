## Why

Living contracts still let mechanical exhaustion, unknown failure, controller failure, process death, and retry exhaustion become terminal stops or human-looking holds. Recovery then depends on the failure site and invocation surface instead of one ownership law.

## What Changes

- Add one lifecycle law: a supervised operation stays owned until verified success, durable Cooling or recovery, an external-condition wait, a current typed-input wait, or explicit cancellation by an authenticated operator or the original authorized caller.
- Define the closed lifecycle states: `active`, `cooling`, `external-condition-wait`, `typed-input-wait`, `succeeded`, and `cancelled`.
- Treat `DecisionRequest`, `CapabilityRequest`, and `AuthorityRequest` as structurally distinct typed-input waits. A raw failure is none of those types. Failure alone never grants human authority and never synthesizes cancellation.
- Consume the existing command-form inventory as the mutating-verb classification. No lifecycle mutation may remain an undocumented carve-out.
- Consume the existing observer catalog for git, forge, checks, reviews, merge, release, deploy, and orchestration state. Process exit is ingress evidence, not success.
- **BREAKING (supervisor policy):** supersede requirements that turn `run_fatal`, `recovery_exhausted`, `repeated_no_progress`, cycle caps, `blocked`, or `needs-human` into lifecycle terminals or human ownership for mechanical, unknown, malformed, process-death, no-progress, capacity, or retry-exhaustion faults.
- Keep `pipeline:needs-human` and `pipeline:blocked` as compatibility projections. Those labels are not scheduler or authority truth.

## Capabilities

### New Capabilities

- `recovery-lifecycle-ownership`: closed lifecycle states; ownership retention; typed human boundary; false-human prohibition; authoritative-evidence binding; explicit cancellation; migration table for legacy terminals.

### Modified Capabilities

- `pipeline-state-machine`: `needs-human` remains a compatibility stage label, not lifecycle cancellation. Process-stop and iteration-cap outcomes do not end RecoverySupervisor ownership.
- `stage-inventory-ssot`: `TERMINAL_STAGES` stays the label inventory. Operator prose must not treat `needs-human` as lifecycle terminal for mechanical exhaustion.
- `durable-blocker-classification`: recipe-budget exhaustion and repeated identical evidence enter Cooling. They do not emit a terminal system-failure stop or human ownership. Genuine typed requests are typed-input waits, not lifecycle terminals.
- `durable-loop-supervisor`: a live `run_fatal` or `recovery_exhausted` record is Cooling (or an external-condition wait). It is not ownerless and not human-owned. Historical `stop.reason` may remain as a compatibility projection.
- `durable-loop-engine`: live-drive `run_fatal` no longer ends Logical Operation ownership. Operator `--resume` remains the wake for historical records.
- `bounded-auto-loop`: round, wall-clock, and recurrence exhaustion enter Cooling or another owned treatment. They do not park as human-owned `needs-human`.
- `loop-needs-human-blocker-disposition`: unattested blocked outcomes stay engine-owned Cooling or recovery. They do not enter terminal system failure or human ownership.
- `human-intervention-taxonomy`: remaining kind descriptions that imply a `needs-human` authority transition for mechanical exhaustion are reporting-only and do not grant human ownership.

## Impact

- **Class vs site:** the class is mechanical, unknown, malformed, process-death, no-progress, capacity, or retry-exhaustion faults becoming terminal or human-looking holds. Shared classifier, recipe, gate, and controller law change together. A path-local mole on one command is incomplete.
- **Reuse first:** RecoverySupervisor (#1323) is the sole owner. Consume `COMMAND_FORM_INVENTORY` (#1329), `typed-request-resolution` (#1326), `operation-invariant-reconciliation` (#1324), and `universal-fault-recovery-matrix` (#1333). Do not add a second supervisor, classifier, inventory, observer package, grant schema, or scheduler.
- **Sequencing:** this change is the living-spec law. #1323 implements RecoverySupervisor observations. #1325 persists episodes, strategy cursors, Cooling, and fenced takeover. This change does not reimplement those issues.
- **CLI:** no new public verb. Advance, single, and loop still never merge.
- **Tests:** hermetic unit tests inject gh/harness/worktree fakes. Contract tests fail when a named legacy terminal still creates human ownership or an ownerless Logical Operation. No real network, git, or subprocess in unit tests.
- **Docs:** align `CONTEXT.md`, `openspec/project.md`, and operator docs so `needs-human` is a compatibility projection of a current typed request.

## Acceptance Criteria

- [ ] Living specs define `active`, `cooling`, `external-condition-wait`, `typed-input-wait`, `succeeded`, and `cancelled` with falsifiable enter/leave rules.
- [ ] A supervised operation stays owned through mechanical failure, unknown failure, malformed output, process death, no progress, capacity, and retry exhaustion.
- [ ] Those faults cannot create `typed-input-wait`, human ownership, synthesized cancellation, or an ownerless terminal.
- [ ] `DecisionRequest`, `CapabilityRequest`, and `AuthorityRequest` remain structurally distinct. A raw failure is none of them.
- [ ] A reversible in-scope authorized recommendation auto-settles. An `AuthorityRequest` is candidate-bound and never records a default grant.
- [ ] Verified success requires the declared observer for git, forge state, checks, reviews, merge, release, deploy, or orchestration state. Process exit 0 is not success.
- [ ] Every mutating `OPERATION_SURFACE` verb has a command-form inventory disposition. No lifecycle mutation remains an undocumented carve-out.
- [ ] Named conflicting requirements in `pipeline-state-machine`, `stage-inventory-ssot`, `durable-blocker-classification`, `durable-loop-supervisor`, `durable-loop-engine`, `bounded-auto-loop`, `loop-needs-human-blocker-disposition`, and `human-intervention-taxonomy` are superseded in this change.
- [ ] A migration table maps `run_fatal`, `recovery_exhausted`, `repeated_no_progress`, cycle caps, `blocked`, and `needs-human` onto the closed lifecycle states.
- [ ] No second scheduler, RecoverySupervisor, classifier, grant schema, or merge-inside-advance path is added.
- [ ] Review, test, release, and deployment gates stay in force.
- [ ] `openspec validate --all` and `npm run ci` pass.
