## Context

agent-pipeline’s merge surface is human-gated: `pipeline merge <pr>` → `mergePr`
with mergeability, required-check, and R2D gates. The merge-queue cluster adds
operator convenience around that surface:

| Slice | Role | Status on main |
|---|---|---|
| #673 | Dry-run selection / order | Shipped (`merge_queue.ts` plan + living `merge-queue-command`) |
| #674 | Sequential apply/drive via `mergePr` | Minimal drive present (`merge-queue.ts` hold-on-throw, continue) |
| #675 | Conflict/CI surgical hold + re-gate | **This change** |
| #676 | Optional release-when-complete | Shipped; treats “held items” as incomplete |

PR #787 shipped a provider-neutral **autonomous recovery controller** for the
durable loop: canonical diagnostics, claim-before-side-effects, deterministic
recipes before `repair_pipeline_item`, bounded budgets, and a strict
human-authority predicate. Post-#787 reconciliation for this issue is explicit:
merge-queue remains a separate operator-authorized surface, but repair **must
reuse** that recovery contract — not invent a second taxonomy or model path.

Constraints that do not move:

- No `auto_merge` config; advance never merges.
- Surgical-fix discipline for any implementer repair (minimal diff, destructive
  op guard, pre-commit self-check).
- Prefer reusing pre-merge CI wait/check helpers over a second poller.
- Single-host / single-operator apply is the supported concurrency scope.

## Goals / Non-Goals

**Goals:**

- Typed hold reasons (`merge-conflict`, `checks-failed`) with remediation text.
- Never force-merge on conflict or red required checks.
- Hold the failed item; continue remaining candidates by default.
- Optional repair: deterministic-first, then bounded mechanical/surgical repair
  in the managed worktree; re-gate; then retry via `mergePr` only.
- Budget exhaustion leaves evidence-rich queue hold / manual-repair outcome
  without falsely claiming human-authority unless attested.
- Hermetic unit tests for the core state machine.

**Non-Goals:**

- Broad feature work, refactors, or scope expansion under “repair.”
- Auto-merge of held items without re-gate success.
- Multi-repo release trains.
- Replacing pre-merge CI recovery for the advance loop (reuse, don’t fork).
- Cross-host distributed merge locking.
- Changing squash / delete-branch merge policy beyond calling `mergePr`.

## Decisions

### D1 — Hold vocabulary is operator-facing, not a second recovery taxonomy

**Decision:** Machine keys at least `merge-conflict` and `checks-failed`. Each
hold record carries: PR number, issue number (when known), reason, summary
evidence, observed head SHA (when known), repair attempts used, and remediation
text. When both conflict and checks fail, **`merge-conflict` wins** (merge graph
must be fixed before checks on a restacked head are meaningful).

**Not a new recovery taxonomy:** these are queue-item outcomes for drive
reporting and release-when-complete completeness. Remediation execution maps
onto the existing recovery ladder (deterministic rebase/check remediation, then
shared mechanical repair) rather than inventing merge-queue-only recipe names
or provider branches.

**Alternatives considered:** free-form error strings only (current minimal drive)
— rejected for unstable operator UX and incomplete release-when-complete
alignment. Full autonomous-recovery reason codes as the only hold keys —
rejected; merge-queue is not the loop supervisor and operators need the two
issue-stated names.

### D2 — Default isolation: hold item, continue remaining candidates

**Decision:** On conflict/red checks (or non-recoverable merge refusal classified
to those reasons), record a hold and **continue** the ordered walk. Do not
force-merge. Do not abandon the whole batch silently.

**Rationale:** Matches shipped `merge-queue.ts` (“on throw, hold and continue”)
and `merge-queue-release-when-complete` (held items keep the queue incomplete
while other merges may still succeed). Also matches the loop’s sibling-
continuation spirit without making merge-queue a loop controller.

**Alternatives considered:** Fail-stop (stop remaining as not-attempted) —
useful for same-base race anxiety and appeared in an earlier closed PR review
thread; **not** the default here because main already continues and #676’s
completeness model is hold-based. A future explicit fail-stop flag is out of
scope unless product demand appears.

### D3 — Repair is opt-in; dry-run and apply-without-repair remain safe

**Decision:** Repair activates only when the operator enables it for the
invocation (CLI flag such as `--repair`) and/or a config key whose **default is
false**. Without repair, conflict/red-check items are held with remediation
text only. Dry-run never merges and never runs repair side effects.

**Authority:** the operator who invoked `--apply` remains merge authority for
that session; enabling repair grants only surgical/mechanical remediation of
held items, never a standing auto-merge grant.

### D4 — Deterministic-first ladder, then shared mechanical repair

**Decision:** When repair is enabled and budget remains:

1. **Classify** eligibility from live PR state (mergeable/CLEAN + checks gate
   shared with selection/merge).
2. **Deterministic remediation first** for the hold class — e.g. clean
   rebase/restack onto the integration base for `merge-conflict`; check
   re-query / settled-failure handling aligned with pre-merge CI helpers for
   `checks-failed` when no code change is required.
3. **Claim** a repair attempt (charge budget) before any model implementer or
   destructive side effect.
4. **Mechanical / surgical repair** via the shared path used by #787
   (`repair_pipeline_item` or the shared mechanical-remediation transaction):
   resolve managed worktree (rematerialize when safe), invoke configured
   implementer with a **surgical-fix-constrained** prompt scoped to conflict
   or CI only, validate/commit/push on the PR head.
5. **Re-gate** eligibility on the new head (same gates as drive/merge).
6. If eligible, **retry merge once** via `mergePr` only; if still ineligible and
   budget remains, may continue the ladder; if budget exhausted, leave typed
   hold/manual-repair outcome with evidence.

**Alternatives considered:** Always invoke implementer first — rejected
(post-#787 and pre-merge experience: thrash and cost). Merge-queue-only repair
prompt path that bypasses claim/budget — rejected (double taxonomy).

### D5 — Re-gate is mandatory; no merge on red or dirty

**Decision:** Any candidate-changing repair (push, rebase that moves HEAD)
invalidates prior eligibility. Drive MUST re-run mergeability + required-check
gates (and open/R2D as applicable) before calling `mergePr`. While checks are
red or merge state is not CLEAN/MERGEABLE, `mergePr` MUST NOT be called (or
its refusal is the only outcome — never a force flag).

Reuse existing check classification from selection/merge (`evaluateChecksGate`
/ `gh pr checks` policy) rather than inventing a second poller. Waiting for
pending checks after a successful restack MAY reuse pre-merge CI wait patterns
within the repair wall-clock budget.

### D6 — Budget model and exhaustion semantics

**Decision:** Per item, per drive session:

- `maxAttempts` (default small, e.g. 1 automatic implementer repair unless
  configured higher).
- Optional `maxWallClockMs` deadline for repair-related wait/work.

`canAttemptRepair(attemptsUsed, budget, now)` is pure and unit-tested.
Claim-before-side-effect: starting an implementer repair consumes one attempt
even on failure/timeout. Deterministic preflight that does not invoke the
implementer SHOULD NOT consume the implementer unit (aligned with #787
rematerialization preflight rules).

**Exhaustion:** record a typed **stopped / manual-repair** queue outcome with
evidence (reason, attempts, head SHA, check/conflict summary, remediation).
For release-when-complete, this counts as a **held item**. It does **not**
emit human-authority / `human_intervention` solely because the budget ended.

### D7 — Module placement and DI

**Decision:**

- Pure hold classification, remediation text, budget, and repair-prompt
  construction in a focused module (e.g. `merge_queue_hold.ts` or colocated
  pure helpers under the merge-queue package).
- Drive orchestration remains in the merge-queue drive entry; it calls pure
  classifiers + injected repair/merge deps.
- `RepairDeps` / drive deps inject: PR view, checks, worktree resolve/
  rematerialize, deterministic rebase/restack, claim/repair executor, `mergePr`,
  clock, logging.
- Unit tests never touch network, git, or subprocesses.

### D8 — Operator-facing report shape

**Decision:** Apply summary lists each candidate as one of at least:
`merged`, `held` (with typed reason + remediation), `skipped-already-done` (if
drive supports it), `failed` (non-repairable hard error), and remaining open
candidates after the walk. Held rows MUST surface reason code and remediation.
Exit non-zero when any item is held or failed for conflict/checks/budget (exact
code aligns with parent CLI conventions; release-prepare may still run only when
completeness allows).

## Risks / Trade-offs

- **[Risk] Same-base mid-queue conflicts after continue** → Later candidates may
  also conflict; holds accumulate. Mitigation: hold evidence + re-run apply
  after repairs; release-when-complete stays blocked until holds clear.
- **[Risk] Implementer expands scope** → Mitigation: surgical-fix prompt
  constraints + pre-commit self-check instruction; re-gate still required;
  budget prevents infinite loops.
- **[Risk] Double taxonomy drift vs #787** → Mitigation: design/spec forbid
  merge-queue-only recovery enums; map to shared executors; tests assert repair
  goes through the injected shared seam.
- **[Risk] TOCTOU between re-gate and merge** → Mitigation: final refuse still
  lives inside `mergePr`; drive never force-merges on refusal.
- **[Risk] Living dry-run spec vs apply code lag** → Mitigation: modify
  `merge-queue-command` only for hold/repair opt-in surface; do not regress
  dry-run zero-mutation defaults.

## Migration Plan

- Additive behavior on apply/drive; dry-run unchanged (no holds required).
- Config default: repair off.
- Rollback: disable repair flag/path; free-form hold-on-throw remains safe
  fallback until typed holds land.
- No data migration; session-scoped hold records only unless durable store is
  already present for the drive (v1 may be in-memory for a single invocation).

## Open Questions

- Exact CLI flag name (`--repair` vs config-only) — prefer `--repair` opt-in
  plus config default false for symmetry with release-when-complete.
- Whether deterministic rebase lives as a thin merge-queue helper or calls an
  existing pre-merge rebase function — prefer reuse if the API is injectable
  without pulling advance-loop side effects.
- Durable multi-session hold ledger is **not** required for v1; a single apply
  invocation’s in-memory hold list is enough for completeness and operator
  output. Multi-session resume can be a follow-up if operators need it.
