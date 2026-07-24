## Why

Epic #528 asks that an integrated `pipeline:loop` run execute **only provably independent** issues
concurrently in separate Pipeline worktrees, while keeping reconciliation and merge safety
serialized. Its governing product rule is conservative: *parallelism is opt-in and unknown overlap
means serialize.*

The epic's three children now exist as separately-reviewed, tested capabilities:

- **#529 `durable-run-ownership-conflicts`** supplies the planning **input**: a per-item ownership +
  conflict declaration, deterministic surface normalization, and a pure pairwise `disjoint`/`conflict`
  evaluator that is conservative on unknown ownership.
- **#530 `durable-run-independent-scheduler`** supplies the planning **decision**: a deterministic,
  budget-bounded independent-set scheduler that consumes dependency, ownership, reconciliation, and
  merge-barrier state, records an allow/deny rationale per candidate, keeps merge-class operations
  globally serialized, and parks items on observed changed-file overlap.
- **#531 `durable-run-parallel-conflict-pilot`** supplies the composition **proof**: a hermetic
  composition simulation plus a live-pilot runbook/evidence-bundle contract.

What no capability yet states is the **epic-level integration contract** — the run-scoped, composed
guarantee a `pipeline:loop` operator actually depends on, expressed at the altitude of #528's four
acceptance criteria rather than any single component. Each child is correct in isolation, but "no
unproven pair ever runs concurrently across the whole run," "merge barriers stay global for the whole
run," and "every parallelize/serialize decision is recoverable from durable evidence for the whole
run" are cross-child invariants that belong to the epic, not to the scheduler pass, the evaluator, or
the pilot fixture alone. Without an owning capability those invariants are implied by three separate
specs and provable only by reading all three together — there is no single place a reviewer can point
to for "the run honored #528."

This change (#528) adds that owning capability: `conflict-aware-parallel-execution`. It is an
**integration contract only** — it introduces no new engine feature and no new stage behavior. It
binds the children into four run-level requirements matching the epic's acceptance criteria, and pins
a single run-scoped **parallelization decision ledger** as the durable artifact that answers "why was
each pair parallelized or serialized" for the *entire run*, not just one scheduling pass. It grants no
merge and relaxes no review gate (golden rule #4).

## What Changes

- **A run-scoped parallelization decision ledger.** Over the life of an integrated `pipeline:loop`
  run, every pairwise parallelize-or-serialize decision the scheduler makes SHALL be appended to a
  single durable, per-run ledger — each entry naming the two items, the disposition
  (`parallelized` | `serialized`), and exactly one structured reason drawn from the scheduler's closed
  reason set (dependency path, conflict edge, unknown ownership, active merge barrier, unresolved
  drift, budget truncation, or admitted/disjoint). The ledger is the run-level answer to #528's first
  acceptance criterion and is derived from the children's already-emitted planning records — it adds
  an accumulation and query surface, not a new decision path.
- **A run-level "no unproven pair runs concurrently" invariant.** At no point in a run SHALL two items
  be simultaneously `in_progress` unless the ledger holds a `parallelized`/`disjoint` decision for
  that exact pair produced by the ownership evaluator and scheduler. Any pair lacking a proven
  disjoint decision — including every unknown-ownership pair — SHALL be serialized. This is the
  composed statement of the children's conservative defaults, asserted for the whole run.
- **A run-level global merge-barrier invariant.** Merge, base refresh, and post-merge reconciliation
  SHALL remain globally serialized for the entire run even while independent items execute
  concurrently: no item starts while a merge barrier is set, and two merge-class operations never
  overlap. The run still stops at `pipeline:ready-to-deploy`.
- **A run-level durable-evidence invariant.** Every action, conflict detection, and scheduling
  decision across the run SHALL be reconstructable from durable evidence alone — the ledger, the
  per-item ownership/normalization records, the reconciliation drift and changed-file-overlap
  records, and each item's action evidence — so the run's parallelization history can be audited from
  recorded truth rather than a narrative summary.
- **An end-to-end integration proof.** The composed guarantee SHALL be proven end-to-end by the
  #531 parallel-conflict pilot (the hermetic composition simulation plus the live-pilot evidence
  bundle), which this capability designates as its acceptance vehicle.

Out of scope: the ownership/conflict model (#529), the scheduler decision (#530), and the pilot
mechanics (#531) — those are shipped. This change adds no new config key beyond the existing
`concurrency` policy, no new external write path, and no auto-merge / auto-release / auto-deploy
(golden rule #4). The freeform (non-OpenSpec) pipeline path and single-item runs are unaffected.

## Acceptance Criteria

- [ ] A durable, run-scoped parallelization decision ledger records **every** pairwise
      parallelize-or-serialize decision of an integrated `pipeline:loop` run — each entry naming the
      two items, a `parallelized`/`serialized` disposition, and exactly one structured reason — and is
      reconstructable from durable run state alone; proven by a test asserting a run with mixed
      disjoint and conflicting items yields one ledger entry per evaluated pair with a reason each.
- [ ] No two items are ever concurrently `in_progress` without a proven-disjoint ledger decision for
      that exact pair: an unknown-ownership pair, a dependency-linked pair, and a conflicting pair each
      run serialized, while a proven-disjoint pair runs concurrently — proven by a composition test
      that bites (fails if any unproven pair is admitted).
- [ ] Merge, base refresh, and post-merge reconciliation stay globally serialized across the whole run
      — no item starts while a merge barrier is set, no two merge-class operations overlap — even after
      concurrent implementation/review work, and the run still stops at `pipeline:ready-to-deploy`;
      proven by the composition simulation.
- [ ] Actual changed-file overlap discovered mid-run parks the affected items and records a durable
      replan request naming the file, never racing either parked item into concurrent merge
      preparation; proven by the composition simulation.
- [ ] Every action, conflict detection, and scheduling decision in the run is reconstructable from
      durable evidence (ledger + ownership records + reconciliation/overlap records + per-item action
      evidence), with no decision provable only from an in-memory or narrative source; proven by an
      evidence-reconstruction test.
- [ ] The composed guarantee is demonstrated end-to-end by the #531 parallel-conflict pilot — the
      hermetic composition simulation in CI and the captured live-pilot evidence bundle linked from the
      pilot issue — covering disjoint concurrency, serialized conflict, changed-file-overlap
      park/replan, and serialized merge-class integration.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror and `npm run ci` (including
      `openspec validate --all`) is green; every new test bites (fails without the change).

## Capabilities

### New Capabilities

- `conflict-aware-parallel-execution`: the epic-level integration contract for conflict-aware parallel
  `pipeline:loop` execution — a run-scoped parallelization decision ledger and the four composed
  run-level invariants (no unproven pair runs concurrently, merge-class operations stay globally
  serialized, changed-file overlap parks and replans, and every decision is durable evidence) that
  bind the ownership/conflict model (#529), the independent-set scheduler (#530), and the
  parallel-conflict pilot (#531) into a single auditable guarantee. It grants no merge authority and
  relaxes no review gate.

## Impact

- **Specs:** one new capability, `conflict-aware-parallel-execution`. It composes and pins existing
  behavior; it modifies no existing requirement of `durable-run-ownership-conflicts`,
  `durable-run-independent-scheduler`, `durable-run-parallel-conflict-pilot`,
  `durable-run-reconciliation`, `durable-run-dependency-integrity`, `durable-loop-engine`, or
  `durable-loop-supervisor`.
- **Code (implementation step only, not this change):** a run-scoped ledger accumulation/query surface
  over the scheduler's already-emitted per-pass planning records (e.g. under `core/scripts/loop/`),
  plus the composition test that asserts the four run-level invariants through the existing injected
  scheduler / ownership / reconciliation / supervisor seams — no new production decision path and no
  real network/git/subprocess in tests.
- **Interoperability:** additive. With no `concurrency` policy every pair is serialized and the ledger
  simply records serial decisions, so an existing durable run's observable behavior is unchanged until
  concurrency is both declared and proven. No new external write path and no auto-merge / auto-release
  / auto-deploy is introduced.
