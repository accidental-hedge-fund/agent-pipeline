## Context

See `proposal.md` for why.

Existing surfaces this change extends:

- RecoverySupervisor vocabulary in `CONTEXT.md` and ADR `0003-supervised-operations-retain-lifecycle-ownership.md`.
- Observation/claim persistence in `core/scripts/operation-observation.ts` (`defaultRecoverySupervisorReport`, `mechanicalFaultObservation`, CAS claims). Merge and ship already use this owner through `merge-supervision.ts` and `ship-supervision.ts`. There is no second supervisor module to invent.
- Issue stages under `core/scripts/stages/` (`planning.ts`, `review.ts`, `fix.ts`, `pre_merge.ts`, `eval.ts`, `visual.ts`, `shipcheck.ts`, `deploy_ready.ts`, `design_gate.ts`, `auto_recover.ts`) plus `core/scripts/recover-parked.ts`. These still retry, block, and terminalize locally.
- Shared worktree seams: `ensureManagedWorktree` (`worktree-rematerialize`) and `classifyWorktreeDirt` (`engine-scratch-recover`).
- Attempt history: `stage-attempt-ledger` plus autonomous-recovery recipes. Operation claims already persist RecoverySupervisor identity.
- Escalation inventory in `escalation-dispositions.ts`. `setBlocked` remains the GitHub projector.
- Transport retry already exists in `gh-transient-retry` and worktree config-lock retry. That is the allowed stage-local loop class.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: issue stages become operation adapters on the existing observation/claim API, matching `runMergeAttempt`. Do not add a second RecoverySupervisor, worktree subsystem, or attempt ledger.
- One bounded adapter attempt per stage invocation. RecoverySupervisor owns reconciliation, treatment, Cooling, and re-entry.
- One materialization capability through `ensureManagedWorktree` for missing, stale, dirty, occupied, and remotely advanced workspaces.
- `auto_recover` and `recover-parked` become compatibility adapters that claim or resume the same Recovery Episode.

**Non-Goals:**

- Merge, release, train, or ship-phase supervision (owned by #1329/#1330/#1331).
- Numeric-drive aliasing to `pipeline single` (owned by #1327).
- Weakening tests, review, OpenSpec, visual, eval, or shipcheck.
- Deleting unknown or unclassified work.
- Classifying product failure from harness or provider names.
- A public `pipeline supervise-advance` verb, grant schema, or second durable scheduler.

## Decisions

### D1 — Reuse the observation/claim API; do not fork a stage supervisor

Issue-stage adapters report through `operation-observation.ts` using the same `ReportOperationObservation` sink merge/ship/command forms already use. If treatment selection is not yet a named module, add it as RecoverySupervisor in that same owner (CONTEXT.md already names it). Do not add `issue-recovery-supervisor.ts` or a per-stage policy object.

Adapter shape matches `runMergeAttempt`: one bounded attempt, typed observation, no lifecycle terminal on mechanical failure. Stage product logic (plan, review verdict, gate command, archive) stays in the existing stage files. Those files stop choosing Cooling, wait, typed request, cancellation, or ownerless stop.

Alternative considered: a new `StageRuntime` framework that wraps every stage. Rejected: YAGNI and a custom layer the implementer would have to build. The merge adapter is the holding rung.

### D2 — Declared invariants live next to the adapter, not in labels

Each issue-advancement stage declares an operation invariant: precondition, postcondition, authoritative observer, candidate binding, and replay rule. The declaration is a typed constant in the stage module (same rung as `MERGE_OPERATION_INVARIANT`). Labels and comments remain projections.

A contract test fails when a `STAGES` delivery handler (planning through ready-to-deploy, excluding inert wait stages `backlog` and `needs-spec`) has no invariant or does not report through the observation sink.

### D3 — Transport retry stays at existing seams; lifecycle retry does not

Stage-local retry is allowed only when all of these hold:

1. The retried operation is proven idempotent.
2. Side-effect certainty is `known_absent`.
3. The retry stays inside the adapter attempt deadline.
4. The candidate epoch has not changed.

`ghRun` transient retry and `git worktree add` config-lock retry already meet this test. Fix-stage crash retry, auto-recovery cap loops, review-round lifecycle retries, and rematerialize-then-block loops do not. Those become observations. RecoverySupervisor may re-enter the adapter.

`auto_recovery_max_retries` is not a stage-local terminalizing budget. If a numeric cap remains, it is RecoverySupervisor strategy-cursor configuration, not a reason to mark the Logical Operation complete, cancelled, or human-owned.

### D4 — Shared materialization is `ensureManagedWorktree`, widened in place

Do not add a workspace-materialization package. Extend `ensureManagedWorktree` so missing, stale (HEAD mismatch / stale manager metadata), dirty, occupied (live owner / live-planning marker), and remotely advanced (PR or remote tip moved) workspaces enter one seam.

Dirt classification stays `classifyWorktreeDirt`:

- Pipeline-owned scratch: unlink or restore.
- Unknown or unclassified dirt: preserve or quarantine; report inconsistency; never delete.
- Known product dirt: fail closed as inconsistency / product-dirt observation, still never force-deleted by materialization.

Occupied workspaces report waiting on the live owner. They do not steal the tree.

### D5 — Candidate replacement starts a new epoch

Candidate movement (new HEAD, rematerialized SHA, remote-advanced tip, replacement worktree) starts a new candidate epoch. Candidate-bound review verdicts, test/eval/shipcheck results, decisions, and authority holds from the prior epoch are invalid. RecoverySupervisor must re-prove those facts against the new candidate. This matches CONTEXT.md Candidate epoch and existing human-hold invalidation in `autonomous-recovery-controller`.

### D6 — `auto_recover` and `recover-parked` are compatibility adapters

`tryAutoRecover` remains callable from advance. It does not own a comment-counted retry cap that permanently blocks. It claims or resumes the Recovery Episode for the Logical Operation, reports an observation, and lets RecoverySupervisor choose reset-to-ready, rematerialize, Cooling, or another treatment.

`pipeline recover-parked` remains the public operator CLI. It still runs deterministic recover first, still refuses HIGH/CRITICAL/security/authority auto-override, and still uses governed override for eligible keys. It claims or resumes the same Recovery Episode. Fingerprint "one pass" becomes a RecoverySupervisor strategy-cursor position, not a command-local terminal. Remaining non-overridable residuals project a park. They do not end ownership.

### D7 — `setBlocked` is a projector

`setBlocked`, stage labels, and blocked comments remain compatibility projections through the lifecycle projector. They do not choose treatment and do not end RecoverySupervisor ownership. Escalation-site inventory rows for issue stages gain a migrated outcome: observation class, RecoverySupervisor treatment, and whether a blocked/needs-human label is still projected.

Quality gates still refuse advancement when they fail. Refusal is an observation plus a projection, not a skipped gate.

### D8 — Incremental migration with a fail-closed inventory

Migrate by stage family, not a big-bang rewrite:

1. Adapter contract + invariant registry + observation reporting on every delivery stage (can be thin wrappers first).
2. Materialization seam widening.
3. Remove stage-local lifecycle loops (fix crash retry, auto_recover cap, rematerialize-block).
4. Compatibility adapters for `auto_recover` and `recover-parked`.
5. Migrated-outcome rows for every former issue-stage blocking site.

A stage is not done until its former blocking sites have migrated-outcome rows and its local lifecycle loops are gone. Merge/ship/command-form adapters stay untouched.

## Risks / Trade-offs

- **[Risk] RecoverySupervisor treatment selection is still thin (observation sink + claims; #1323 module may be incomplete).** → Mitigation: consume the existing observation/claim API as the owner. Put issue-stage treatment in that owner. Do not ship a second policy module. Implementation tasks that need treatment APIs wait on that same owner, not a fork.
- **[Risk] Existing specs require stage-local retry-then-block (`fix-harness-crash-retry`) and rematerialize-then-block (`worktree-rematerialize`).** → Mitigation: this change MODIFIES those requirements. Do not average them with the new adapter law.
- **[Risk] Compatibility projections (`setBlocked`, `needs-human`) can be mistaken for terminals.** → Mitigation: contract tests prove a blocked projection leaves `owned: true` and does not mark complete/cancelled/human-owned unless a genuine current authority request exists.
- **[Risk] Widening `ensureManagedWorktree` could force-destroy dirty trees.** → Mitigation: dirty/unknown reclaim refusal stays. Unknown dirt is preserved or quarantined. Tests fail if a fixture deletes unclassified paths.
- **[Risk] Bounded auto-loop could remain a second lifecycle budget.** → Mitigation: auto_loop continuation is allowed only as RecoverySupervisor re-entry. It cannot terminalize after Cooling is required.
- **[Risk] Migrating all `setBlocked` sites in one PR is large.** → Mitigation: the inventory and adapter reporting land first; site-by-site loop removal follows in the same change's task order, gated by the drift test.

## Migration Plan

1. Land adapter/invariant/observation contract tests (red on current stages).
2. Wire each delivery stage to report one observation per attempt without changing product gates.
3. Point workspace faults at the widened `ensureManagedWorktree`.
4. Move fix-crash, no-op-unsatisfied, malformed-output, and auto_recover/recover-parked onto RecoverySupervisor treatment.
5. Fill migrated-outcome rows until the escalation drift guard is green.
6. Keep `npm run ci` green, including `openspec validate --all`.

Rollback is revert of this change. Observation reporting is additive. Removing a local retry loop without the supervisor path is not an allowed partial rollback.

## Open Questions

None. Remaining sequencing (#1323 owner completeness, #1327 numeric alias) is fail-closed consumption, not an open design choice for this issue.
