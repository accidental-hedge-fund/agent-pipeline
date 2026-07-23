## Why

Epic #528 wants an integrated `pipeline:loop` run to execute only **provably independent** issues
concurrently in separate worktrees, while keeping pre-merge, merge, base-refresh, and post-merge
reconciliation serialized. The three planning **inputs** now exist as tested contracts — dependency
integrity (#513, `durable-run-dependency-integrity`), ownership + conflict evaluation (#529,
`durable-run-ownership-conflicts`), and verified live reconciliation (#511,
`durable-run-reconciliation`) — but nothing **consumes** them to pick a concurrent set. Today the
supervisor is hard-serialized: it starts exactly one eligible item (`eligible[0]`) and refuses any
`in_progress` transition while another item is active (`eligibleIndependentItems`,
`supervisor.ts`). There is no scheduler that combines those inputs into a bounded independent set,
so #528's parallelism cannot exist and the epic's governing rule — *parallelism is opt-in and
unknown overlap means serialize* — has no place that enforces it.

This change (#530) supplies the missing **deterministic scheduler**: given the compiled contract,
the live ledger, the ownership conflict verdicts, external-dependency statuses, reconciliation
drift, and the merge-barrier state, it selects a **concurrency-bounded, provably-independent set**
of items to start — or, absent an explicit run policy and proof, exactly one item as today. It is a
pure **planning decision** over already-verified inputs; it never merges, never bypasses review, and
never relaxes the serialized merge barrier. It is the third and final child of #528, and it composes
the first two plus the reconciliation seam into a single audited selection.

## What Changes

- **A serialized-by-default concurrency policy.** A new, optional `concurrency` run policy on the
  loop contract governs the scheduler's budget. Absent or set to `1`, behavior is **identical to
  today** — one active item, fully serialized. Concurrency above `1` is honored **only** when the
  policy explicitly enables it *and* the scheduler can prove the selected items independent; unknown
  overlap always collapses back to serial. This is additive and opt-in — non-loop and single-item
  runs are unaffected.
- **A deterministic independent-set scheduler.** A pure `selectSchedulableSet(...)` decision that,
  from the eligible-item frontier, admits a set that is pairwise independent by **all** of:
  dependency/ordering (no in-snapshot or external dependency path, no `blocked` dependency), the
  ownership conflict evaluator (`evaluateConflict` ⇒ `disjoint` for every admitted pair), no shared
  merge barrier, and no unresolved live reconciliation drift on any candidate. The set is ordered
  deterministically and truncated to the configured budget.
- **A recorded allow/deny rationale for every candidate.** The scheduler emits a durable planning
  record naming, for each eligible candidate, whether it was **admitted** or **serialized/denied**
  and the single structured reason (dependency path, conflict edge, unknown ownership, active merge
  barrier, unresolved drift, or budget-truncation). This is an audit artifact only — producing it
  schedules nothing by itself.
- **Global serialization of merge-class operations.** Merge, base refresh, and final reconciliation
  remain singleton/barrier operations even while independent items run concurrently — the scheduler
  admits no item into `in_progress` while a merge barrier is set, exactly as
  `durable-loop-engine`'s barrier already mandates, and never schedules two merge-class operations
  at once.
- **Changed-file drift parking + replan request.** When concurrently-run items are observed to have
  actually changed **overlapping files** — real overlap that the declared ownership did not predict
  — the scheduler parks the affected items and records a **replan request** rather than proceeding.
  Already-completed independent evidence for unaffected items is preserved.
- **Idempotent, evidence-preserving failure handling.** A blocked or failed member of a concurrent
  set neither re-drives already-attempted work nor invalidates the independence evidence of its
  siblings; the next scheduling pass recomputes deterministically from durable state.

## Capabilities

### New Capabilities
- `durable-run-independent-scheduler`: the deterministic, concurrency-bounded independent-set
  scheduler that consumes dependency, ownership/conflict, reconciliation, merge-barrier, and
  run-policy inputs to decide which durable-run items may start concurrently, records an allow/deny
  rationale for every candidate, keeps merge-class operations globally serialized, and parks items
  on observed changed-file overlap.

### Modified Capabilities
<!-- None. The scheduler consumes durable-loop-engine, durable-run-dependency-integrity,
     durable-run-ownership-conflicts, and durable-run-reconciliation as inputs without changing
     their requirements. The serialized-by-default guarantee keeps the existing
     durable-loop-engine merge-barrier and single-active-item behavior intact. -->

## Impact

- **Code:** new pure scheduler module under `core/scripts/loop/` (e.g. `schedule.ts`) plus its
  types in `core/scripts/loop/types.ts`; an additive `concurrency` field on the loop contract
  schema; a call site in `core/scripts/loop/supervisor.ts` that replaces the single `eligible[0]`
  pick with the scheduler's selected set (serialized default preserved); a new durable planning
  record written alongside existing action/ownership evidence; regenerated `plugin/` mirror.
- **Tests:** new `core/test/loop-schedule.test.ts` covering dependency chains, independent triples,
  conflict pairs, unknown ownership, changed-file drift parking, and serialized merge barriers, all
  through injected seams with no real network/git/subprocess.
- **Out of scope / unchanged:** the merge button (the pipeline still stops at
  `pipeline:ready-to-deploy`), the review gates, the freeform non-OpenSpec path, and single-host
  concurrency scope (#459) for the host-local `/tmp` locks.

## Acceptance Criteria

- [ ] With no `concurrency` policy (or `concurrency: 1`), the scheduler selects exactly one item and
      run behavior is byte-for-byte the serialized behavior of today.
- [ ] The selected set is deterministic — the same contract/ledger/verdict/drift/barrier inputs
      always yield the same ordered set — and never exceeds the configured concurrency budget.
- [ ] Every admitted pair in a concurrent set is proven `disjoint` by the ownership conflict
      evaluator, has no dependency path (in-snapshot or external) between them, shares no active
      merge barrier, and carries no unresolved reconciliation drift.
- [ ] Any candidate with a dependency path, an explicit/derived conflict edge, unknown ownership, a
      shared active merge barrier, or unresolved live drift is **serialized** (excluded from the
      concurrent set), never admitted.
- [ ] The scheduler records a durable allow/deny rationale for **every** eligible candidate, each
      carrying exactly one structured reason.
- [ ] Merge, base refresh, and final reconciliation are globally serialized: no item is admitted to
      `in_progress` while a merge barrier is set, and two merge-class operations are never scheduled
      concurrently.
- [ ] Observed changed-file overlap among concurrently-run items parks the affected items and
      records a replan request, without invalidating unaffected items' independence evidence.
- [ ] A blocked or failed member of a concurrent set does not duplicate external work and does not
      invalidate its independent siblings' evidence; the next pass recomputes deterministically.
- [ ] Unit tests cover dependency chains, independent triples, conflict pairs, unknown ownership,
      changed-file drift, and serialized merge barriers, each with no real network/git/subprocess,
      and each proven to bite (fails without the scheduler).
