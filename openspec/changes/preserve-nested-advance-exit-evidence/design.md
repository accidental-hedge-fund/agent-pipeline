## Context

See `proposal.md`. The dispatch seam already observes the child `exit` event but discarded both callback arguments. The supervisor also constructed a new diagnostic for every `failed` response, even when the producer supplied a canonical diagnostic. Recovery supports diagnostic-specific recipe filtering, currently used for Tester evidence ordering.

## Goals / Non-Goals

**Goals:**

- Retain the process-boundary facts already available at the spawn seam.
- Preserve authoritative-state precedence over process status.
- Make recovery selection deterministic from structured fields.

**Non-Goals:**

- Capturing or persisting arbitrary child stderr, which could contain secrets.
- Treating exit zero as proof of completion.
- Adding a new blocker class or changing implementer/reviewer routing.

## Decisions

1. Add an optional `process_exit` member to `pipeline/stage-diagnostic@1` detail. This is backward-compatible and keeps process facts adjacent to the existing canonical recovery diagnostic. A parallel event-only payload was rejected because recovery must consume the fact directly.
2. Construct the diagnostic only after fresh issue/run classification still resolves to `failed`. This preserves the authoritative-observer rule: a process exit is ingress evidence, not lifecycle truth.
3. Preserve any valid `recover` diagnostic returned with a failed loop-execution response. Invalid, capacity, or authority-shaped diagnostics still fail closed through the existing generic engine-defect path.
4. Filter structured nested-child exits to `restart_workflow_engine`. Product repair and evidence-rebind recipes cannot repair a dead dispatcher process and were the source of the observed recovery delay. Matching free-form reason text was rejected because recovery decisions must be deterministic and non-linguistic.
5. Validate the complete process-exit shape and its producer context centrally before any consumer may narrow recovery. Exactly one abnormal termination fact is required: a positive integer exit code or a non-empty signal. The enclosing diagnostic must be the `workflow-engine-defect` / `harness-failure` / `loop-dispatch` tuple. Authoritative observation failure retains an already-observed abnormal termination because failure to observe is not contrary completion evidence.

## Risks / Trade-offs

- [A repeated deterministic child failure can still recur after restart] → Existing repeated-evidence bounds and Cooling retain ownership without invoking unrelated product repair.
- [Older consumers ignore the additive detail member] → The existing reason code and blocker kind remain valid, so compatibility degrades to the prior bounded engine recovery.
- [Raw stderr could explain more] → Do not persist it; exit code/signal plus the child run store provide a safe diagnostic join point.

## Migration Plan

No data migration is required. Deploy the additive producer and consumer changes together. Rollback restores generic recovery behavior without invalidating existing diagnostic records.
