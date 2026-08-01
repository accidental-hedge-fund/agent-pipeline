## Context

The durable loop already persists a recovery policy, per-class budgets, fingerprints, and an
append-only attempt list. Production does not execute any recipe: the child response carries only
a coarse outcome, blocked labels become `blocked_needs_human`, and `blockItem` can stop a run before
`recoverItem` is reachable. The incident demonstrated every failure mode of that split at once.

The per-item pipeline remains the only component that understands stages, worktrees, review
currency, and configured harness roles. The durable supervisor must remain provider- and
stage-neutral and must never gain merge/deploy/release/credential authority.

## Goals / Non-Goals

**Goals:**

- Make recovery policy executable in production and restart-safe.
- Derive recovery and authority from one typed diagnostic, never labels or prose.
- Give every non-authority failure a bounded engine-owned path: retry, reconcile, wait, or repair.
- Re-enter normal review, CI, and pre-merge gates after every repair.
- Preserve independent sibling progress and truthful terminal accounting.

**Non-Goals:**

- Automatic merge, deploy, release, credential entry, override, or authority widening.
- Provider-specific behavior or provider promotion policy.
- Unlimited retry or weakening review severity/policy.

## Decisions

### 1. One diagnostic is the policy input

Blocked outcomes carry `pipeline/stage-diagnostic@1` with a closed `reason_code`, stable
`evidence_key`, and optional structured detail. One exhaustive projection derives blocker kind,
durable class, human intervention (or none), and permitted recipes. Policy is never inferred from
the issue label, terminal outcome name, or diagnostic prose.

Alternative rejected: adding more `blocked_*` outcomes. That recreates parallel taxonomies and
still loses the evidence needed for idempotency.

### 2. Human authority requires positive attested evidence

Only a current, attested `human-decision-required` record for an effective blocking finding and a
`product-decision` or `authority` category can create an answer/authority hold. Missing diagnostic,
generic `needs-human`, merge conflicts, validation failures, exhausted repair, and labels alone are
never authority proof. Unknown v2 diagnostics are protocol/engine defects.

### 3. Claim before side effect

The attempt ledger is keyed by `(item, candidate identity, evidence fingerprint, action)` and stores
status, budget, `not_before`, last error, and idempotency key. The controller durably claims and
charges an attempt before executing it. Failed actions consume budget. A future deadline defers the
item without blocking sibling scheduling; the idle driver waits in heartbeat-sized slices. Resume
reconciles a `started` claim against live truth before replay.

Alternative rejected: worktree marker files and completion-only charging. Both permit either
permanent suppression or unbounded crash replay.

### 4. Whole-item repair execution

`repair_pipeline_item` is a provider-neutral supervisor recovery action. Its registered executor
resolves the normal configured implementer/model/effort, rematerializes/synchronizes the worktree,
invokes the shared mechanical-remediation transaction with the exact diagnostic,
validates/commits/pushes, and returns. The supervisor then redispatches the same item through the
existing whole-item facade, which re-runs all review and gate logic. The supervisor never branches
on OpenSpec, merge conflict, review round, or harness name.

### 5. Reconcile at every authority boundary

The supervisor reconciles immediately before a recovery side effect and again before persisting its
result or a hold/stop. Its idempotent repair executor may reconcile the exact marked commit produced
by an interrupted attempt; unrelated identity movement is refused. Fresh ready/merged/closed truth
supersedes stale recovery, and candidate movement invalidates human authority retained for the old
SHA. Driver exit writes a terminal/completion event only for a genuinely terminal result. A claimed
recovery remains durable and resumable across process failure.

### 6. OpenSpec failures are structured fixtures, not special policy

OpenSpec archive uses JSON mode and verifies both the explicit archive result and active-directory
removal. Archive apply conflicts and post-revision validation errors emit exact reason codes. The
shared repair transaction receives those diagnostics and may repair once per keyed budget; OpenSpec
does not decide whether the failure is human-owned.

## Risks / Trade-offs

- **A generic repair prompt could make an unsafe broad change** -> constrain paths/authority,
  require normal commit/test/review gates, and make the implementer emit a no-action result when the
  diagnostic cannot be repaired safely.
- **Crash replay could duplicate external effects** -> claim before action and reconcile the
  idempotency postcondition against live head/labels before retry.
- **Legacy events lack diagnostics** -> classify them as engine/manual-classification work, never
  as human authority; preserve v1 reading during migration.
- **Recovery can consume time** -> honor per-class budgets and keep independent siblings
  schedulable.

## Migration Plan

1. Add diagnostic/reason projections and additive event/response fields while retaining v1 reads.
2. Correct recovery primitive semantics and add the executor registry.
3. Wire supervisor scheduling, restart hydration, and reconciliation.
4. Route current stage blockers through diagnostics and shared repair.
5. Remove label/prose authority inference after compatibility tests pass.

Rollback is a code rollback; additive fields remain ignored by older readers. No data migration is
destructive because ledger fields are optional and upgraded on read.

## Open Questions

None block this implementation. Future #647 may add richer human-context handoff semantics without
changing the strict authority predicate.
