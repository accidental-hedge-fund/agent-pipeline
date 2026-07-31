## Context

The merge-queue cluster (v1.29.0) is human-gated and merge-authority-bound to the operator
who invokes apply/drive:

| # | Role |
|---|------|
| #673 | Spec + dry-run selection/order |
| #674 | Sequential drive via existing `/pipeline:merge` |
| **#675 (this)** | Conflict/CI surgical hold + re-gate |
| #676 | Optional release prepare when complete |

Today, `pipeline merge` already refuses non-mergeable and red-required-check PRs
(`merge-sub-command`). Pre-merge has bounded conflict rebase and CI recovery
(`pre-merge-conflict-detection`, `pre-merge-ci-gate`), but those run **before**
`ready-to-deploy`, not during a human merge-queue walk of R2D PRs. Surgical-fix
discipline (`surgical-fix-rounds`) already constrains fix harness diffs.

Without this change, drive either aborts the whole batch on the first dirty PR or leaves
operators to manually restack/fix/re-check outside any shared hold/re-gate contract.

**Constraints:**

- Pipeline never merges without explicit operator merge-queue/apply or `pipeline merge`.
- No `auto_merge` config key; advance loop stays merge-free.
- Reuse existing merge gates and CI/check helpers — do not invent a second poller.
- Repair MUST stay surgical; broad feature work under "conflict fix" is out of scope.
- Depends on #674 for drive loop, single-flight merge, and stop/hold policy surface.

## Goals / Non-Goals

**Goals:**

- Stable hold reason vocabulary (`merge-conflict`, `checks-failed`) with remediation text.
- Fail-closed: never merge while conflicted or while required checks are red/pending-failing.
- Default drive policy: **hold the bad item, continue remaining candidates**.
- Optional, budget-bounded surgical repair + mandatory re-gate before merge retry.
- Testable pure/decision seams via injected deps (no real network/git in unit tests).

**Non-Goals:**

- Auto-merge of held items without re-gate.
- Parallel merges to the same base.
- Multi-repo release trains or #676 release cutting.
- Replacing pre-merge CI recovery; this is the **merge-queue drive** path after R2D.
- Expanding fix scope to feature work, refactors, or unrelated cleanup.
- Cross-host distributed merge locks beyond single-operator session assumption (document only).

## Decisions

### Decision 1 — Hold reasons are a small closed vocabulary

**Choice:** Define at least:

| Reason | When recorded | Remediation (operator-visible) |
|--------|---------------|--------------------------------|
| `merge-conflict` | `mergeable` is not MERGEABLE / `mergeStateStatus` is DIRTY (or equivalent conflict signal used by the drive eligibility check) | Resolve conflicts on the PR branch (manual or enable repair), push, re-run drive/merge |
| `checks-failed` | Any required check bucket is `fail`, `pending`, or `cancel` when drive expects green required checks | Fix or wait for required checks on the head SHA; re-run drive/merge |

Names are stable machine keys; human text can be richer. Additional reasons (e.g.
`merge-api-error`) MAY exist on the drive side (#674) but this capability **requires** the
two above for conflict/CI.

**Alternatives:** Reuse pre-merge `BlockerKind` (`merge-conflict`, `ci-exhausted`) wholesale
— rejected for the queue surface because drive holds are session/queue-scoped, not
necessarily issue-label `pipeline:blocked` state; mapping can align later without coupling
vocabularies.

### Decision 2 — Default policy is hold-item-and-continue

**Choice:** On `merge-conflict` or `checks-failed`, record a per-item hold, **skip merge**
for that PR, and continue with remaining ordered candidates. Drive reaches a terminal
"outstanding holds" summary when finished walking the list (or when no candidates remain
mergeable). Aligns with `loop-blocked-item-hold-continuation` and the operator goal of
clearing a milestone queue without one dirty PR stranding clean siblings.

**Stop-all** remains available only if #674 explicitly offers a flag; this capability's
**default** is hold-and-continue and tests lock that default.

**Alternatives:** Stop-all-on-first-hold — simpler but abandons the batch; rejected as
default given the user story.

### Decision 3 — Optional repair is opt-in; surgical-fix only

**Choice:** Repair runs only when enabled by config and/or an explicit drive flag (e.g.
`--repair`). When enabled:

1. Resolve the PR's **managed worktree** (existing worktree lifecycle / managed-worktree
   resolution — no ad-hoc clone outside managed roots).
2. Invoke fix/implementer with a prompt (or shared fix builder) that encodes **surgical-fix
   discipline**: minimal diff for conflict resolution or CI failure only; forbid refactors
   and scope expansion; guard destructive ops to managed worktree root / reviewed head.
3. Push repair commits to the PR head only through normal non-force push unless an explicit
   justified force-with-lease is required for a rebase and is scoped to the reviewed head.

When repair is disabled, hold + remediation text is sufficient (human repairs out of band).

**Alternatives:** Always-on auto-repair — rejected; merges remain human-gated and repair is
expensive/riskier. Silent broad implementer — rejected by surgical-fix and issue out-of-scope.

### Decision 4 — Re-gate before every merge retry; reuse existing merge surface

**Choice:** After any repair push (or after a held item is reconsidered on a later drive),
eligibility MUST re-run the **same** gates the drive uses before merge:

- PR still open
- Linked issue still R2D / policy labels as defined by selection (#673/#674)
- Mergeable + clean merge state
- Required checks green (same shape as `merge-sub-command` / drive re-validation)

Only then invoke **`mergePr` / existing merge path** — never a raw unguarded `gh pr merge`
fork and never skip checks because "we just fixed it."

**CI polling:** Prefer reusing existing check aggregation helpers used by merge and/or
pre-merge (`getPrChecks` / `gh pr checks --required` patterns). Do **not** add a second
long-poll subsystem; drive may wait briefly or re-evaluate on the next item/cycle depending
on #674's wait policy, but green required checks remain mandatory at merge time.

### Decision 5 — Bounded repair budget

**Choice:** Per-item repair budget with both:

- `max_repair_attempts` (default small, e.g. 1–2)
- Optional `max_repair_wall_clock_s` (if waiting on CI after repair)

Exhaustion: leave item **held** with evidence (reason, attempt count, last check/conflict
summary, worktree path if any). No further automatic repair until a new drive with budget
reset policy defined as: new operator-invoked drive may retry if still ineligible, but
must not loop unbounded within one drive session.

**Alternatives:** Unbounded retry until green — rejected (non-converging cost). Infinite
CI wait — rejected; wall-clock bound or re-queue for human.

### Decision 6 — Dependency injection and evidence

**Choice:** Pure decision functions + `deps` seam for worktree resolve, harness invoke,
checks, mergeability, merge — mirroring `MergeDeps` / stage deps. Persist hold records in
the drive run output/artifact (session-scoped), not as a new global GitHub label scheme
unless #674 already defines one. Evidence fields at minimum: `pr`, `issue`, `hold_reason`,
`remediation`, `repair_attempts`, `last_head_sha`, `checks_summary` / `mergeability`.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Repair harness expands scope ("while I'm here") | Surgical-fix prompt discipline + tests; budget 1–2 attempts |
| TOCTOU: green then red between re-gate and merge | Existing `--match-head-commit` on merge surface |
| Coupling to unfinished #673/#674 APIs | Spec behavioral contracts (hold, re-gate, no force-merge); implementation lands after drive skeleton |
| Second CI poller / divergence from merge gates | Reuse merge required-check helper; single source of eligibility |
| Hold-and-continue merges later PRs that depend on held PR | Document ordering assumption: candidates are independently mergeable or operator orders dependencies; no auto reorder in v1 |
| Operator confuses queue hold with `pipeline:blocked` | Distinct vocabulary and output; do not auto-set blocked labels unless drive design requires |

## Migration Plan

1. Spec-only this change; no runtime behavior until implement after/with #674.
2. Implementation adds hold + optional repair modules; dry-run (#673) remains non-mutating.
3. Default: repair **off** until flag/config enables it — safe rollout.
4. Rollback: disable repair flag; holds still prevent force-merge if drive is present.

## Open Questions

1. Exact CLI flag names (`--repair`, `merge_queue.repair.enabled`) — bikeshed at implement
   time with #674 command surface.
2. Whether a held item from a prior drive is sticky across sessions (artifact only) or
   purely re-derived each dry-run/apply from live PR state — prefer **re-derive from live
   truth** each drive; prior evidence is advisory.
3. Default `max_repair_attempts` (recommend **1** for v1) — confirm at implement.
