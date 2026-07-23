## Tasks

## 1. Types & run policy
- [x] 1.1 Add an additive, optional `concurrency` run policy to the loop contract schema
      (`core/scripts/loop/types.ts`, `LOOP_CONTRACT_SCHEMA`): a positive-integer budget, default
      `1`. Document that absent/`1` ⇒ fully serialized (existing behavior).
- [x] 1.2 Add the scheduler types: a `ScheduleDisposition` union (`admitted` | `dependency_path` |
      `conflict_edge` | `unknown_ownership` | `merge_barrier` | `unresolved_drift` |
      `budget_truncation`), a per-candidate `ScheduleRationale` (`item_id`, `disposition`, and the
      structured detail — the conflicting item id / overlapping surface where applicable), and the
      `ScheduleDecision` (`selected: string[]`, `rationale: ScheduleRationale[]`).
- [x] 1.3 Add the durable **replan-request** record type (affected item ids + overlapping file
      paths + reason) for changed-file-overlap parking.

## 2. Scheduler (pure)
- [x] 2.1 Add `selectSchedulableSet(input)` in a new pure module `core/scripts/loop/schedule.ts`.
      Derive the candidate frontier from `eligibleIndependentItems(contract, ledger,
      externalStatuses)`, order it by the documented total order, then greedily admit each candidate
      only if pairwise-independent of every already-admitted item, stopping at the budget.
- [x] 2.2 Implement the independence predicate as the conjunction of: dependency-free (no
      `depends_on`/`external_depends_on` path, not gated on `blocked`), ownership-disjoint
      (`evaluateConflict` ⇒ `disjoint`; unknown ownership ⇒ conflict), barrier-free, and drift-free.
      Apply the fixed reason precedence (dependency → conflict-edge → unknown-ownership → barrier →
      drift → budget) so the recorded reason is deterministic.
- [x] 2.3 Emit a `ScheduleRationale` entry for **every** candidate — admitted or denied — with
      exactly one structured disposition. Guarantee the decision is a pure, deterministic function of
      its inputs (no clock, no I/O).

## 3. Merge-class serialization
- [x] 3.1 Admit nothing while a merge barrier is set (honor `durable-loop-engine`'s barrier without
      re-implementing it); ensure the scheduler never yields two merge-class operations (merge, base
      refresh, final reconciliation) concurrently.

## 4. Changed-file-overlap parking
- [x] 4.1 Add `detectChangedFileOverlap(actualChangedFiles)` that compares the observed changed-file
      sets of concurrently-run items and returns the affected item ids + overlapping paths not
      predicted by declared ownership.
- [x] 4.2 On detected overlap, park the affected items and write a durable replan-request record;
      preserve unaffected items' independence evidence; perform **no** external mutation (no merge,
      push, or branch/worktree deletion).

## 5. Supervisor wiring
- [x] 5.1 In `core/scripts/loop/supervisor.ts`, replace the single `eligible[0]` start with a call
      to `selectSchedulableSet(...)` and start each member of `selected` (each in its own managed
      worktree). Preserve the serialized default exactly when budget is `1`/absent.
- [x] 5.2 Persist the schedule rationale alongside existing action/ownership evidence; ensure a
      blocked/failed member recomputes deterministically on the next pass without duplicating work or
      invalidating siblings' evidence.

## 6. Tests (injected seams, no real I/O)
- [x] 6.1 `core/test/loop-schedule.test.ts`: **serialized default** — absent/`1` budget selects
      exactly one item and matches existing behavior.
- [x] 6.2 **Dependency chain** — a dependent and its prerequisite are never co-admitted.
- [x] 6.3 **Independent triple** — three disjoint, dependency/drift/barrier-free items are admitted
      together under a budget ≥ 3; and truncated correctly under a smaller budget.
- [x] 6.4 **Conflict pair** — two `conflict` items yield at most one admitted; rationale names the
      conflict-edge reason and counterparty.
- [x] 6.5 **Unknown ownership** — an undeclared/uncovered-surface item is serialized.
- [x] 6.6 **Changed-file drift** — observed overlap parks the affected items, records a replan
      request, and preserves an unaffected item's evidence.
- [x] 6.7 **Serialized merge barrier** — an active barrier admits nothing; merge-class operations do
      not overlap.
- [x] 6.8 **Determinism** — the same inputs yield an identical ordered selected set and rationale
      across repeated calls. Prove each test bites (fails without the scheduler).

## 7. Build & gate
- [x] 7.1 Regenerate the mirror: `node scripts/build.mjs` and commit `plugin/`.
- [x] 7.2 `npm run ci` green from repo root (`ci:core` → `build.mjs --check` → install-smoke →
      `openspec validate --all`).
