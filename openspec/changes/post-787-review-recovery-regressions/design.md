## Context

PR #787 introduced a provider-neutral recovery controller, but three durable boundaries retained
older assumptions. Review recurrence and settled-finding memory read all issue comments, resumed
contracts retained policy snapshots that lacked the repair fallback, and reconciliation treated an
open PR as proof that any local state should advance to `pr_opened`. In #626/#675 those combined to
create false human holds while recovery budgets remained unused or a started attempt was orphaned.

## Goals / Non-Goals

**Goals:**

- Make review recurrence evidence round-, production-transition-, and candidate-movement-bound.
- Keep unresolved review findings blocking while assigning remediation to the recovery controller.
- Upgrade known obsolete policy defaults without overwriting operator customization.
- Make a charged blocked recovery claim survive restart and bare open-PR observation.
- Keep all behavior independent of harness/provider choice.

**Non-Goals:**

- Weakening review thresholds, silently accepting high findings, or adding automatic merge.
- Replacing the broader diagnostic and disposition consolidation owned by #759/#760.
- Rewriting immutable contract identity or retroactively modifying persisted contract files.

## Decisions

1. **Attested child-run identity and production repair sequence.** Review output carries the
   child-run id as a validated `ReviewArtifact` field, with a human-readable `pipeline-review-run`
   marker retained inside the body-hash envelope. Routing reads only the artifact field, so legacy
   reviewer prose cannot inject lineage evidence. A prior review counts only
   when trusted transitions for that same prior child run prove `review-N -> fix-N` and then the
   actual production exit (`fix-1 -> review-2` or `fix-2 -> pre-merge`), and the next reviewed SHA
   differs. Current durable redispatch has a fresh child run id by design. Settled-finding memory
   uses current-child-run reviews so stale history cannot demote a fresh blocker.

   Alternative: infer attempts from comment ordering or labels. Rejected because neither proves
   which controller run or repair attempt produced the review.

2. **Repair-first durable block instead of stage transition.** Exact recurrence, non-demotable
   surface recurrence, and non-demotable ceiling exhaustion emit a `review-findings` blocker,
   reason code, and durable class. Stage-local auto-loop excludes it. Its default durable policy
   selects only `repair_pipeline_item`, so label clearing or `rerun_ci` cannot redispatch an
   unchanged candidate. The durable controller owns bounded repair and fresh review.
   New or mixed blockers route to `fix-N`; below-high fully recurring blockers may still use the
   configured demote-and-advance path.

   Alternative: transition to `needs-human` and let the supervisor reinterpret it. Rejected because
   that pollutes authority state and bypasses recovery in single-item and resumed paths.

3. **Additive class-by-class runtime policy migration.** Missing current classes are added without
   resetting the policy. Exact stale default entries are replaced by the current entry. Custom
   entries retain recipes, order, budgets, backoff, fatality, and repeat limits,
   except the obsolete `reauthenticate` token is renamed to executable `verify_authentication`.
   Engine-defect defaults receive two retry/repeat units so both restart and repair are reachable.
   The resulting complete policy is compiled; malformed policies still fail closed.

   Alternative: replace every resumed policy with the current default. Rejected because it erases
   operator policy. Versioning the immutable contract was also rejected for this patch because the
   runtime already has a compatibility upgrader and identity must remain stable.

4. **Blocked state outranks bare PR existence.** `blocked + open PR` is aligned for reconciliation.
   Verified ready or merged truth may still supersede recovery. This preserves a started attempt and
   its charge across restart while allowing actual completion to win.

## Risks / Trade-offs

- **Legacy comments lack run identity** -> they remain usable for display/correction history but
  cannot prove recurrence or consume a ceiling.
- **Runtime migration is shape-sensitive** -> migrate only exact known defaults, compile the result,
  and test custom and malformed policies.
- **Mechanical recovery can still exhaust** -> preserve actionable finding evidence and terminate as
  a typed system failure rather than fabricating human authority.
- **Comment protocol grows another marker** -> validate its alphabet and cover formatter/parser
  round trips and stale-run rejection.

## Migration Plan

Ship the code and regenerated plugin together. Existing runs are upgraded in memory on the next
recovery entry; missing current classes are added without resetting customization and no persisted
canonical hash changes. After installation, return #626 to `fix-1` and
#675 to `fix-2` so fresh run-bound review evidence is created. Rollback restores the previous plugin
but cannot safely recover those items, so rollback requires pausing the affected loop.

## Open Questions

None for this release blocker. Broader taxonomy consolidation and producer-wide diagnostic coverage
remain in #759 and #760.
