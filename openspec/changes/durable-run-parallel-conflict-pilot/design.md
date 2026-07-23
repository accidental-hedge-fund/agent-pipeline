## Context

Issue #531 is a **test/pilot** item, not a feature. The conflict-aware parallel durable-loop runtime
already ships as reviewed capabilities: the ownership + conflict declaration schema and pairwise
evaluator (#529, `durable-run-ownership-conflicts`), the independence scheduler that admits
concurrency only under an explicit policy with proven independence (#530,
`durable-run-independent-scheduler`), verified reconciliation (#511,
`durable-run-reconciliation`), dependency integrity (#513, `durable-run-dependency-integrity`), and
the in-repo supervisor (#512, `durable-loop-supervisor`) — each unit-tested through its injected
seam in isolation. What is missing is a *composition-level* proof: a single run that admits more than
one item concurrently, serializes a conflicting one, and survives a mid-run changed-file overlap,
carried through the supervisor's reconcile → select → dispatch → record cycle and the
globally-serialized merge barrier.

This is the parallel analog of #515 (`durable-run-two-item-live-pilot`), which pinned the same
composition proof for the *serialized single-active-item* path. The same two constraints apply:

1. **The repo's test discipline forbids real I/O in the unit suite** (CLAUDE.md golden rules; unit
   tests inject `gh`/harness/worktree/scheduler fakes and make zero real network/git/subprocess
   calls).
2. **A live parallel run is inherently non-hermetic and non-repeatable** — its value is precisely
   that it ran against a real GitHub repository, with real concurrent worktrees and real human
   merges.

These pull in opposite directions, so the pilot is defined with **two verification tiers** rather
than forcing one to serve both purposes. This design deliberately mirrors #515's structure so the
two pilots read as a matched pair.

## Decision 1 — Two tiers: hermetic composition simulation + live-pilot runbook

- **Tier 1 (CI-enforced): a hermetic composition simulation.** One end-to-end test drives the whole
  disjoint-concurrency → serialized-conflict → changed-file-overlap-park → serialized-merge sequence
  through the *existing* scheduler, pairwise-ownership-evaluator, `SupervisorDeps`, and reconciliation
  fakes. This proves the composed control flow — concurrent admission under budget, conflict
  serialization with a structured reason, changed-file-overlap parking and replan, the globally
  serialized merge barrier, per-item worktree isolation, and idempotency — deterministically, with
  zero real I/O, and can run forever in CI. It is the durable regression guard.
- **Tier 2 (one-time, human-run): a live-pilot runbook + evidence contract.** The actual live
  parallel run cannot live in CI; instead the change pins *what the live run must do and capture*.
  The runbook is the reproducible procedure; the evidence-bundle contract is the falsifiable
  done-condition.

**Alternative rejected:** a single "integration test" that shells out to real `gh`/git and spawns
real concurrent worktrees. It would violate the no-real-I/O rule, be flaky under real concurrency,
and could not exercise *human* merges — so it would prove less than either tier while costing more.

## Decision 2 — Minimal fixture shape: a disjoint pair plus one conflicting item

The fixture is the smallest run that forces every target behavior: items **A** and **B** whose
normalized ownership surfaces evaluate `disjoint`, plus item **C** whose declaration conflicts with
an admitted item — all under a `concurrency` run policy with budget > 1.

- Two disjoint items (not one) are required to exercise **concurrent admission**, **separate managed
  worktrees**, and **independent evidence** — a single item cannot demonstrate concurrency.
- A third **conflicting** item is required to exercise **serialization with a structured reason** —
  the scheduler must exclude C and name exactly one closed-set reason and the admitted item C
  conflicts with.
- The A↔B pair additionally carries the **mid-run changed-file-overlap** leg: their *declarations*
  say disjoint, but the observed changed files overlap, which is exactly the case the scheduler must
  park and replan rather than proceed to concurrent merge preparation.

A larger fixture would add cost without adding a distinct composition behavior; the issue explicitly
scopes a two-disjoint-plus-one-conflict shape.

## Decision 3 — Conflict serialization resolves from declared/evaluated truth, overlap from observed truth

Two distinct conflict channels are exercised, and the pilot keeps them separate:

- **Declared/evaluated conflict (item C).** C is serialized because the pairwise ownership evaluator
  returns `conflict` for C against an admitted item — from a co-owned shared surface, an overlapping
  exclusive glob, an explicit `conflicts_with` edge, or unknown ownership. This is a *planning-time*
  decision made before either item runs.
- **Observed changed-file overlap (A↔B).** A and B were admitted as `disjoint` from their
  declarations, but the *observed* changed files overlap — a fact only available mid-run. This is
  the scheduler's park/replan path, driven by observed truth, not by re-reading declarations.

The simulation asserts both channels independently so a bug in one cannot be masked by the other:
C is serialized at planning time; A/B are parked at observation time.

## Decision 4 — Each concurrent item runs in its own separate managed worktree

`durable-run-independent-scheduler` requires each admitted item to run in its own managed worktree so
one member's failure leaves the others untouched. The pilot asserts worktree identity is per-item and
disjoint, and that a member failure does not re-drive or invalidate a sibling's independence
evidence. In the hermetic simulation this is modeled through the injected worktree seam reporting
distinct managed roots per item; the live runbook makes the separate-worktree requirement an explicit
observable.

## Decision 5 — Human owns every merge; merge-class operations stay globally serialized

Golden rule #4: the pipeline never merges. Even with concurrent implementation and review, the
scheduler keeps merge / base refresh / final reconciliation globally serialized — no item starts
while a merge barrier is set, and no two merge-class operations overlap. In the live pilot a human
presses each merge button; the pilot only *observes* the merge surface to clear barriers. In the
hermetic simulation this is modeled by the merge-barrier state in the scheduler fakes — never by the
pilot issuing a merge. The simulation asserts each admitted item still passes its own review and
pre-merge gates and the run stops at `pipeline:ready-to-deploy`.

## Decision 6 — Evidence bundle is derived, not narrated

The pilot's evidence bundle references concrete recorded artifacts — the observed concurrency (which
items ran together), the pairwise ownership decisions and their structured reasons, per-item worktree
identity, the changed-file-overlap detection and its replan request, and each item's terminal
outcome — reusing the existing `evidence-bundle` capability's projection and the scheduler's durable
planning record rather than inventing a bespoke report. A reviewer verifies the pilot by reading
recorded truth. The simulation asserts each of the five behaviors is locatable in the bundle; the
live evidence bundle is the artifact linked from #531.

## Decision 7 — Parking and planning records mutate nothing external

Both the changed-file-overlap park and the planning record that serializes C are audit artifacts:
producing them starts, merges, or serializes nothing in an external system, and parking performs no
merge, push, label write, or branch/worktree deletion. The simulation counts the injected seam's
external mutation calls across the park and the serialization decisions and asserts **zero**
additional external writes — turning `durable-run-independent-scheduler`'s "the record schedules
nothing on its own" and "parking mutates no external system" requirements into explicit
composition-level assertions.

## Risks / trade-offs

- **The live tier cannot be CI-gated.** Mitigated by making Tier 1 the durable regression guard and
  Tier 2 a pinned, reviewable runbook + a linked evidence bundle on #531 — the done-condition is an
  artifact, not a claim.
- **Simulation could pass while masking a real integration gap.** Mitigated by Decision 3 (two
  conflict channels asserted independently) and the bite checks (task 7.3): each assertion is proven
  to fail when its behavior is defeated, so a green test means the behavior is actually exercised,
  not stubbed.
- **Real concurrency is harder to reproduce than the serial pilot.** Mitigated by the data-driven
  scripted scheduler fake (task 1.2): the concurrent admission, serialization, overlap, and merge
  phases are sequenced deterministically with no clock or randomness, so the hermetic tier is stable.
