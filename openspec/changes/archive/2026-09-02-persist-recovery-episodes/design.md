## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- CONTEXT.md Recovery Episode, Strategy cursor, Cooling, Side-effect certainty, Candidate epoch, and Fenced lease vocabulary. ADR `0003-supervised-operations-retain-lifecycle-ownership.md`.
- Write-ahead recovery claims in `core/scripts/loop/recovery.ts` (`startRecoveryAttempt`, `attempt_id` idempotency, `not_before` / `next_attempt_at`, `started` before side effect).
- `LoopCoolingRecord` on the durable ledger (`core/scripts/loop/types.ts`) and operation-claim CAS in `core/scripts/operation-observation.ts`.
- Treatment history on `stage-attempt-ledger` plus `claimOrResumeRecoveryEpisode` in `issue-stage-adapters.ts` (today an observation only).
- Same-host fencing: durable-loop-store lock (pid + starttime + opaque token) and the unified issue-run lock. Liveness Provider already reuses those fences.
- Recipe catalogue and compiled recovery policy in `loop/recovery.ts`. Production selection still uses class-wide `retry_budget` and `matchingAttempts.length % executableRecipes.length`, which can hide later recipes.

#1324 owns invariants and authoritative observers. This change consumes those observers for claim reconciliation. It does not invent a second observer.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: persist Recovery Episodes by extending `LoopRecoveryAttempt`, `LoopCoolingRecord`, operation claims, and the stage-attempt ledger. Do not add a RecoveryEpisode database, lease service, or second scheduler.
- Per-strategy bounds and a monotonic cursor so later configured recipes remain reachable.
- Inapplicable deterministic recipes skip without consuming repair budget.
- Mechanical `run_fatal`, `recovery_exhausted`, no-progress, capacity, and cycle-cap become Cooling or waits.
- Fenced same-host takeover that reconciles uncertain claims before mutation.
- Generation quarantine on the existing atomic write path.
- Crash tests at every durable-write and external-side-effect boundary.

**Non-Goals:**

- A distributed database, second durable scheduler, or cross-host mutual exclusion beyond the existing fence.
- Infinite immediate retry.
- Reimplementing RecoverySupervisor (#1323), invariants (#1324), recommendation-first requests (#1326), lifecycle projector (#992), numeric admission (#1327), issue-stage adapters (#1328), command-form inventory (#1329), train/merge (#1330), ship (#1331), liveness policy owner (#1332), or the fault matrix (#1333).
- Converting genuine typed requests or authenticated cancellation into Cooling.
- A public `pipeline supervise-recovery` verb, grant schema, or merge stage.

## Decisions

### D1 — Persist episodes on the existing recovery-attempt family

Add Recovery Episode fields to the shared recovery-attempt / operation-claim records: invariant identity, candidate epoch, normalized evidence identity, attempts per strategy, strategy cursor, and `next_eligible_at`. `claimOrResumeRecoveryEpisode` becomes a real persist/resume of that record, not only an observation. `LoopCoolingRecord` remains the Cooling projection on the loop ledger.

Alternative considered: a new `recovery-episodes/` store under state-home. Rejected: YAGNI and a competing schema that `stage-attempt-ledger` already forbids.

### D2 — Per-strategy bounds replace class-wide budget as production authority

Keep the compiled recovery policy and recipe order. Charge attempts per applicable recipe, not against one class-wide `retry_budget`. `retry_budget` may remain as a compatibility projection during migration. Production selection walks the configured list in order, skips inapplicable recipes, and advances the cursor when a strategy's own bound is spent.

Alternative considered: keep class-wide `retry_budget` and only skip inapplicable recipes. Rejected: that is the current failure class. Early recipes still hide later ones.

### D3 — Cursor reset is epoch or material evidence, not restart

Resume the same episode across process restart. Reset only on a new candidate epoch or a new normalized evidence identity. Fingerprint purity stays the existing recovery fingerprint function.

### D4 — Cooling is capped exponential and never ends ownership

When every applicable strategy is exhausted, or repeated evidence hits its bound, persist Cooling with `next_eligible_at` from the existing backoff fields (`initial_seconds`, `multiplier`, `max_seconds`). Wake is not manual reinvocation. Independent siblings stay schedulable.

### D5 — Write-ahead claims stay `startRecoveryAttempt`

Do not add a second claim primitive. Extend `startRecoveryAttempt` so the claim is candidate-bound, fenced by the current lock token, and carries the episode cursor. Replay of the same `attempt_id` after crash returns the existing claim without a second charge. Inapplicable skips are a distinct recorded outcome and do not call `startRecoveryAttempt` for a side effect.

### D6 — Fencing reuses the store lock and issue-run lock

Takeover uses the existing provably-dead same-host recovery path (remove lock, acquire fresh token, pid + starttime). After attach, reconcile outstanding `started` claims through #1324 observers before any new mutation. Do not add a lease service. Cross-host locks stay non-stale.

### D7 — Generation quarantine extends atomic write, not a new log

The store already writes tmp + fsync + rename. Detect unreadable JSON, schema failure, leftover tmp files, and unpublished renames. Quarantine the bad generation with evidence. Reconstruct from the last valid generation plus live truth when safe. If unsafe, keep the operation owned as Cooling or wait. Do not add a generation database.

### D8 — Mechanical stop reasons become Cooling; historical tokens may remain

Live writes of `run_fatal`, `recovery_exhausted`, `repeated_no_progress`, `supervisor_no_progress`, `supervisor_cycle_cap`, and `worktree_capacity` as lifecycle stops are removed. Historical records remain readable as evidence. `--resume` catch-up for GitHub-ready items stays. Genuine typed requests stay typed requests.

Operator `--resume` of historical `run_fatal` remains a compatibility path that supersedes that evidence and continues owned work. A live mechanical fault does not require `--resume` to retain ownership.

## Risks / Trade-offs

- **[Risk] Class-wide `retry_budget` still exists on persisted contracts.** → Mitigation: runtime migration keeps the field as a projection. Production charging uses per-strategy counts. Tests fail if a class-wide zero hides a later applicable recipe.
- **[Risk] Existing specs still require `run_fatal` / `supervisor_no_progress` terminals.** → Mitigation: this change MODIFIES those requirements. Do not average them with Cooling.
- **[Risk] Takeover that mutates before observer proof can duplicate side effects.** → Mitigation: crash tests at claim-start, observer-read, and fence-publish boundaries. Uncertain claims wait.
- **[Risk] Quarantine without a last valid generation could look ownerless.** → Mitigation: unsafe reconstruction stays Cooling or wait with quarantine evidence. It does not mint a new Logical Operation and does not become human authority.
- **[Risk] Cooling wake could tight-loop.** → Mitigation: `next_eligible_at` is durable. Wake before that time is a no-op for that episode. Independent siblings still schedule.
- **[Risk] #1324 observers are still landing.** → Mitigation: consume the declared observer interface. Implementation tasks that need a specific observer wait on that invariant, not a fork.
- **[Risk] Historical `run_fatal` resume tests currently expect a new live `run_fatal`.** → Mitigation: rewrite those fixtures so re-exhaustion cools. Keep historical-resume catch-up.

## Migration Plan

1. Land episode field + cursor + per-strategy counting tests (red on current class-wide budget and round-robin selection).
2. Persist episode fields on `LoopRecoveryAttempt` / operation claims / stage-attempt ledger. Point `claimOrResumeRecoveryEpisode` at that record.
3. Skip inapplicable recipes without charging repair. Walk configured order by cursor.
4. Persist Cooling instead of mechanical stop reasons. Keep historical evidence readable.
5. Wire takeover to reconcile `started` uncertain claims before mutation.
6. Detect and quarantine truncated or invalid generations on the existing atomic write path.
7. Add crash tests for every durable-write and external-side-effect boundary.
8. Keep `npm run ci` green, including `openspec validate --all`.

Rollback is revert of this change. Adding episode fields is additive. Removing a mechanical stop without Cooling is not an allowed partial rollback.

## Open Questions

None. Remaining sequencing (#1323 owner completeness, #1324 observers) is fail-closed consumption, not an open design choice for this issue.
