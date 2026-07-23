## Context

This is the third and final child of epic #528. Its two siblings supply the planning **inputs**:

- **#513 `durable-run-dependency-integrity`** — `LoopContractItem.depends_on` (in-snapshot,
  order-constraining, cycle-checked) and `external_depends_on` (out-of-snapshot, verified live);
  `eligibleIndependentItems(contract, ledger, externalStatuses)` already computes the frontier of
  items whose dependencies are satisfied and that are not gated on a `blocked` dependency
  (`core/scripts/loop/recovery.ts`).
- **#529 `durable-run-ownership-conflicts`** — `evaluateConflict(...)` returns a typed
  `OwnershipConflictVerdict` (`disjoint | conflict` + structured reason) and
  `recordOwnershipEvidence(...)` writes the normalized-surface planning evidence
  (`core/scripts/loop/ownership.ts`, types in `core/scripts/loop/types.ts`).
- **#511 `durable-run-reconciliation`** — verified live drift classification
  (`classifyDrift`, `LoopDriftClass`) and the merge barrier held by `durable-loop-engine` until
  reconciliation observes the merged commit.

Today `supervisor.ts` is hard-serialized: it starts `eligible[0]` and refuses any new
`in_progress` transition while an item is active. This change replaces that single pick with a
deterministic **independent-set scheduler** that consumes all of the above, without changing any of
those input capabilities' requirements.

## Goals / Non-Goals

**Goals**
- A pure, deterministic `selectSchedulableSet(...)` decision over already-verified inputs.
- Serialized-by-default; concurrency strictly opt-in via a `concurrency` run policy **and** proof.
- A recorded allow/deny rationale for every eligible candidate.
- Global serialization of merge-class operations; changed-file-overlap parking with replan request.

**Non-Goals**
- No new verification of dependencies, ownership, or reconciliation truth — those are inputs,
  consumed as-is. The scheduler re-derives nothing they already prove.
- No merge, no review relaxation, no change to the stop at `pipeline:ready-to-deploy` (#528/golden
  rule 4). No auto-merge or `auto_merge` key.
- No cross-host guarantee beyond the documented single-host concurrency scope (#459) — the scheduler
  runs on one host and drives that host's worktrees.

## Decisions

### 1. Pure decision function, thin supervisor call site
`selectSchedulableSet(input)` is a pure function in a new `core/scripts/loop/schedule.ts`, mirroring
the injected-seam discipline of `ownership.ts`/`dependencies.ts`. Its inputs are the compiled
`LoopContract`, the `LoopLedger`, the ownership verdict lookup (or the declarations it evaluates
via `evaluateConflict`), the `externalStatuses` map, the reconciliation drift set, and the
merge-barrier state. It returns `{ selected: string[]; rationale: ScheduleRationale[] }`. The
supervisor's existing `eligibleIndependentItems` → `eligible[0]` block is replaced by a call that
starts each member of `selected` (still one, in the serialized default). Keeping the decision pure
lets the six required test cases run with zero real I/O.

### 2. Greedy admission over a deterministic candidate order
Candidates come from `eligibleIndependentItems` (already dependency- and blocked-safe), then are
ordered by the contract's documented total order (contract item order / id). The scheduler walks the
ordered frontier and admits a candidate only if it is **pairwise independent of every
already-admitted item** by all checks (§Decision 3), stopping when the set reaches the budget. Greedy
+ fixed order = deterministic and order-stable; a denied candidate never reorders later ones. This is
simpler than a max-independent-set search and matches the conservative product rule — we do not need
the *largest* independent set, only a *proven* one within budget.

### 3. The independence predicate is the conjunction of the input capabilities
A pair `(a, b)` is independent iff **all** hold:
- **Dependency-free:** no `depends_on`/`external_depends_on` path either direction, and neither gated
  on a `blocked` dependency. (The frontier already enforces satisfied deps; the pairwise check
  guards against a same-pass sibling being a dependency.)
- **Ownership-disjoint:** `evaluateConflict(a, b) === disjoint`. Unknown ownership resolves to
  `conflict` inside the evaluator (#529), so it is serialized here with no special-casing.
- **Barrier-free:** no active merge barrier applies (see Decision 4).
- **Drift-free:** neither `a` nor `b` carries an unresolved reconciliation drift record.
Any failing check denies the candidate with that single structured reason. The reason precedence is
fixed (dependency → conflict-edge → unknown-ownership → barrier → drift → budget) so the recorded
reason is deterministic when several apply.

### 4. Merge-class operations stay globally serialized
The scheduler does not re-implement the barrier — `durable-loop-engine` already refuses an
`in_progress` transition while a barrier is set. The scheduler simply admits nothing when a barrier
is set, and treats merge / base-refresh / final-reconciliation as a singleton it never schedules
twice. This preserves the hard-won convergence behavior and keeps golden rule 4 intact.

### 5. Changed-file-overlap parking is a post-run safety net, not a pre-run gate
Declared ownership is the pre-run proof; but a declaration can be wrong. After concurrently-run items
produce their actual changed-file sets, the scheduler compares them: any real overlap not predicted
by the declarations **parks** exactly the affected items and records a durable **replan request**
naming the overlapping files. It never merges, pushes, or deletes anything (surgical, non-destructive
per the fix discipline). Unaffected items keep their evidence. This closes the gap between declared
and actual surfaces without weakening the conservative default.

### 6. Idempotence via recompute-from-durable-state
The scheduler holds no cross-pass mutable state; each pass recomputes `selected` from the durable
ledger + inputs. A blocked/failed member simply leaves its siblings' `in_progress` state and evidence
untouched, and the next pass re-derives deterministically — so a failure causes no duplicate external
action and no lost proof. Each admitted item runs in its own managed worktree (existing
`worktree.ts`), so failures are physically isolated.

## Risks / Trade-offs

- **Greedy ≠ maximum independent set.** We may leave an admittable item for the next pass when a
  different admission order would have fit it. Acceptable: throughput is secondary to a *proven*,
  deterministic, conservative selection, and the next pass picks it up.
- **Declaration accuracy.** The pre-run proof is only as good as the ownership declarations; Decision
  5's changed-file parking is the backstop, and unknown ownership already serializes.
- **Single-host scope (#459).** The scheduler and its worktrees are host-local; two hosts scheduling
  the same run is out of scope, consistent with the documented concurrency disposition.

## Migration

Additive and opt-in. Existing runs carry no `concurrency` policy, so the scheduler selects one item
and behavior is unchanged. No data migration; the new planning record is written alongside existing
evidence.

## Open Questions

- Exact source of each item's **actual changed-file set** for Decision 5 (git diff of the managed
  worktree vs. base at reconciliation time) — to be pinned during implementation against the existing
  worktree/reconciliation seams; the spec requires only that observed overlap parks and replans.
