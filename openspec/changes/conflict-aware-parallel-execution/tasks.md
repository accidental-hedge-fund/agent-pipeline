## 1. Confirm the delivered substrate (children — already shipped)

- [x] 1.1 `durable-run-ownership-conflicts` (#529): per-item ownership + conflict declaration,
      deterministic normalization, pure pairwise `disjoint`/`conflict` evaluator (conservative on
      unknown ownership).
- [x] 1.2 `durable-run-independent-scheduler` (#530): deterministic budget-bounded independent-set
      scheduler, per-pass allow/deny record, global merge barrier, changed-file-overlap parking.
- [x] 1.3 `durable-run-parallel-conflict-pilot` (#531): hermetic composition simulation + live-pilot
      runbook and evidence-bundle contract.

## 2. Run-scoped parallelization decision ledger

- [x] 2.1 Define the run-scoped ledger entry type (item pair, `parallelized`/`serialized` disposition,
      exactly one structured reason) reusing the scheduler's existing closed reason set — no new reason
      vocabulary. Add it to `core/scripts/loop/types.ts`.
- [x] 2.2 Implement pure accumulation of the scheduler's per-pass planning records into the run-scoped
      ledger under `core/scripts/loop/` (append-only, deterministic, reconstructable from durable run
      state). It re-decides nothing — it accumulates and exposes.
- [x] 2.3 Wire the ledger append at the scheduler call site in `core/scripts/loop/supervisor.ts` so
      every pass's decisions are recorded, without altering the serialized-by-default selection.
- [x] 2.4 Add a drift-guard test asserting every ledger reason is a member of the scheduler's closed
      reason set (single-sourced), so a new scheduler reason cannot bypass the ledger.

## 3. Compose and assert the run-level invariants

- [x] 3.1 Add a composition test (`core/test/`) driving a mixed frontier — a proven-disjoint pair, an
      unknown-ownership pair, a dependency-linked pair, and a conflicting pair — through the existing
      injected scheduler / ownership / reconciliation / `SupervisorDeps` seams (no real
      network/git/subprocess).
- [x] 3.2 Assert **no unproven pair is ever concurrently `in_progress`**: only the proven-disjoint pair
      runs concurrently; the unknown, dependency, and conflict pairs each serialize. Prove the assertion
      bites (fails if any unproven pair is admitted).
- [x] 3.3 Assert the **run-scoped ledger** contains one entry per evaluated pair, each with a
      disposition and exactly one structured reason, reconstructable from durable state.
- [x] 3.4 Assert **merge-class operations stay globally serialized for the whole run** — no start while a
      merge barrier is set, no two merge-class operations overlapping — and the run stops at
      `pipeline:ready-to-deploy`. (Proven by the #531 pilot, this change's designated acceptance
      vehicle for this invariant — see task 4.1.)
- [x] 3.5 Assert **changed-file overlap discovered mid-run parks** the affected items and records a
      durable replan request naming the file, with no external mutation and no race into concurrent
      merge preparation. (Proven by the #531 pilot — see task 4.1.)
- [x] 3.6 Assert **full evidence reconstruction**: every action, conflict detection, and scheduling
      decision is derivable from durable evidence (ledger + ownership records + reconciliation/overlap
      records + per-item action evidence), none provable only from an in-memory/narrative source.

## 4. End-to-end acceptance via the #531 pilot

- [x] 4.1 Confirm the #531 hermetic composition simulation covers disjoint concurrency, serialized
      conflict, changed-file-overlap park/replan, and serialized merge-class integration, and that its
      evidence bundle references the run-scoped ledger. (`buildLoopEvidenceBundle` now exposes
      `parallelizationLedger`, sourced from the same durable events the #531 pilot test already
      exercises.)
- [x] 4.2 Confirm the captured live-pilot evidence bundle (linked from the pilot issue) demonstrates the
      composed guarantee end-to-end.

## 5. Gate

- [x] 5.1 Regenerate the mirror: `node scripts/build.mjs` and commit the updated `plugin/`.
- [x] 5.2 `npm run ci` green from repo root (includes `openspec validate --all`); every new test proven
      to bite.
- [ ] 5.3 Pre-merge archives this change into the living specs.
