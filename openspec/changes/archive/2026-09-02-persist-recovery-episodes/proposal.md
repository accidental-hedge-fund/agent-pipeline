## Why

Class-wide recovery budgets can exhaust before later configured recipes run. They can also turn repeated mechanical failure into `run_fatal`, `recovery_exhausted`, `supervisor_no_progress`, `supervisor_cycle_cap`, or `worktree_capacity` — ownerless terminals that drop RecoverySupervisor ownership. Supervisor death still needs an operator-driven resume. RecoverySupervisor must persist candidate-scoped Recovery Episodes with a monotonic strategy cursor, per-strategy bounds, durable Cooling, write-ahead claims, and fenced same-host takeover so ownership survives process restart.

## What Changes

- Persist Recovery Episodes keyed by operation, invariant, candidate epoch, and normalized evidence identity. Each episode records attempts per strategy, a monotonic strategy cursor, and `next_eligible_at`.
- Bound each applicable strategy separately. Exhaustion advances the cursor. Exhaustion of all applicable strategies enters capped exponential Cooling. Cooling never ends lifecycle ownership.
- Skip inapplicable deterministic recipes without consuming substantive repair budget, so later configured recipes remain reachable in production order.
- Change treatment or enter Cooling when evidence repeats. Do not tight-loop the same strategy. Independent siblings remain schedulable while one item cools.
- Keep side-effect claims write-ahead, candidate-bound, fenced, and reconciled before replay. Fencing stays same-host. Remote correctness uses stable idempotency identity plus authoritative post-observation.
- Support fenced takeover after process death. Takeover reconciles uncertain side effects before any new mutation.
- Detect truncated, invalid, or partial durable generations. Quarantine them with evidence. Reconstruct from the last valid generation plus live truth when safe.
- Remove mechanical `run_fatal`, `recovery_exhausted`, no-progress, capacity, and cycle-cap terminal outcomes as lifecycle stops. Historical evidence tokens MAY remain. Genuine typed requests and authenticated cancellation stay.
- Add crash tests at every durable-write and external-side-effect boundary.

## Capabilities

### New Capabilities

- `recovery-episodes`: persist candidate-scoped Recovery Episodes on the existing recovery-attempt and operation-claim family; strategy cursor; per-strategy bounds; Cooling with `next_eligible_at`; write-ahead fenced claims; same-host takeover that reconciles before mutation; generation quarantine; crash-boundary tests.

### Modified Capabilities

- `durable-blocker-classification`: class-wide `retry_budget` SHALL NOT terminalize ownership or hide later recipes. Each applicable strategy has its own bound. Inapplicable deterministic recipes SHALL NOT consume repair budget. Repeated identical evidence SHALL change treatment or enter Cooling, not a terminal `repeated_no_progress` stop.
- `durable-loop-store`: mechanical stop reasons SHALL become owned Cooling or waits. Truncated, invalid, or partial durable generations SHALL be detected, quarantined with evidence, and reconstructed from the last valid generation plus live truth when safe. Fenced takeover SHALL invalidate the dead holder's token.
- `durable-loop-supervisor`: live mechanical `run_fatal`, `recovery_exhausted`, `supervisor_no_progress`, `supervisor_cycle_cap`, and `worktree_capacity` outcomes SHALL enter Cooling or an external-condition wait. Independent siblings SHALL remain schedulable while another item cools. Takeover SHALL resume the same run identity after reconciling outstanding claims.
- `stage-attempt-ledger`: Recovery Episode records SHALL include invariant, candidate epoch, evidence identity, attempts per strategy, cursor, and `next_eligible_at` on the shared recovery-attempt family. The engine SHALL NOT persist a competing private episode schema.
- `autonomous-recovery-controller`: inapplicable deterministic recipes SHALL skip without consuming substantive repair budget. Recipe selection remains RecoverySupervisor treatment through the persisted cursor.
- `liveness-provider`: after a dead same-host holder, fenced takeover SHALL reconcile uncertain side effects before mutation. The provider still SHALL NOT choose recovery recipes.
- `worktree-capacity-admission`: residual worktree capacity SHALL enter owned Cooling or an external-condition wait. It SHALL NOT persist `worktree_capacity` as a lifecycle terminal stop. Independent siblings that already hold slots SHALL remain owned.

## Impact

- **Class vs site:** class-wide recovery budgets, mechanical terminal stops, and operator-only resume after supervisor death are one class: RecoverySupervisor ownership that does not survive strategy exhaustion or process death. The class fix is a persisted Recovery Episode with a strategy cursor, per-strategy bounds, Cooling, write-ahead claims, and fenced takeover. A mole on one recipe, one stop reason, or one command path is incomplete.
- **Reuse first:** extend `LoopRecoveryAttempt` / `startRecoveryAttempt` (write-ahead `started` claim, `attempt_id` idempotency, `not_before`), `LoopCoolingRecord`, operation-claim CAS in `operation-observation.ts`, stage-attempt-ledger, and the durable-loop-store lock (pid + starttime + opaque token). Do not add a RecoveryEpisode database, a second durable scheduler, a lease service, or a public supervisor CLI verb.
- **CLI:** no new public verb. Advance, single, and loop still never merge. `pipeline recover-parked` stays an operator CLI. Cooling wake-up and bound resume are not manual reinvocation.
- **Sequencing:** consumes RecoverySupervisor (#1323) as sole lifecycle owner and operation invariants / reconciliation (#1324). Does not reimplement recommendation-first requests (#1326), lifecycle projector (#992), numeric admission (#1327), issue-stage adapters (#1328), command-form inventory (#1329), train/merge exactness (#1330), ship phases (#1331), liveness (#1332), or the fault matrix (#1333).
- **Tests:** hermetic unit tests inject store/lock/observer fakes. Crash tests cover every durable-write and external-side-effect boundary. Contract tests fail when a class-wide budget hides a later recipe, when inapplicable recipes consume repair budget, when mechanical exhaustion writes a terminal stop, when takeover mutates before reconciliation, or when a truncated generation is treated as live authority. No real network, git, or subprocess in unit tests.
- **Docs:** keep CONTEXT.md Recovery Episode, Strategy cursor, and Cooling vocabulary. Align living specs. This planning change does not edit application code.

## Acceptance Criteria

- [ ] A persisted Recovery Episode records invariant, candidate epoch, evidence identity, attempts per strategy, strategy cursor, and `next_eligible_at`. A fixture missing any of those fields fails.
- [ ] Exhausting one applicable strategy advances the cursor to the next configured applicable recipe. The Logical Operation stays owned. A fixture that writes `run_fatal` or `recovery_exhausted` as a lifecycle stop at that point fails.
- [ ] An inapplicable deterministic recipe (for example `verify_head_goal` when HEAD is absent, or a never-started preflight recipe) records a skip and does not consume the substantive repair budget. The next applicable recipe remains reachable.
- [ ] A class-wide remaining budget of zero cannot hide a later configured applicable recipe that has not yet spent its own bound.
- [ ] Repeated identical evidence on the same episode changes treatment or enters Cooling with a future `next_eligible_at`. It does not tight-loop the same strategy in the same cycle.
- [ ] While item P is Cooling, a proven-independent sibling remains schedulable. The run does not whole-stop solely because P cools.
- [ ] After the holding process dies on the same host, a later process claims a fenced lease (pid + starttime + new token). The dead holder's token no longer authorizes mutation.
- [ ] Takeover of a `started` claim with `uncertain` side-effect certainty observes the authoritative observer before replay. Proven complete is reconciled forward. Proven absent may replay under the same idempotency identity. Still-unknown remains an owned wait. Takeover does not mutate first.
- [ ] A truncated, invalid, or partial durable generation is detected, quarantined with evidence, and not treated as live authority. Reconstruction uses the last valid generation plus live truth when safe.
- [ ] Live mechanical `run_fatal`, `recovery_exhausted`, `repeated_no_progress` / `supervisor_no_progress`, `worktree_capacity`, and `supervisor_cycle_cap` outcomes persist as Cooling or an external-condition wait. They do not end lifecycle ownership. Genuine typed requests and authenticated cancellation remain.
- [ ] Crash tests cover every durable-write and external-side-effect boundary used by Recovery Episode claims, cursor advances, Cooling writes, lease takeover, and generation quarantine.
- [ ] Tests inject all external I/O. `npm run ci` passes.
- [ ] No RecoveryEpisode database, second durable scheduler, lease service, grant schema, merge stage, or public supervisor CLI verb is introduced.
- [ ] The next identical class fault (budget exhaustion, process death mid-claim, truncated ledger write, repeated evidence) is handled by this shared episode/cursor/cooling/takeover law and does not require a new mole issue.
