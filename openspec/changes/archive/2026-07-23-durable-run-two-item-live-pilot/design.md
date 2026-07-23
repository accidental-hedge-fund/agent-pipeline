## Context

Issue #515 is a **test/pilot** item, not a feature. The integrated durable-loop runtime already
ships as reviewed capabilities (`durable-loop-supervisor`, `durable-run-reconciliation`,
`durable-run-dependency-integrity`, `durable-blocker-classification`, `blocked-recovery-recipes`,
`durable-run-blocker-auto-file`), each unit-tested through its injected seam in isolation. What is
missing is a *composition-level* proof: a single run that carries more than one item, with a real
recoverable interruption, through the supervisor's reconcile → select → dispatch → record cycle and
the reconciliation-driven merge-refresh barrier that gates a dependent item.

Two facts constrain how this pilot can be specified:

1. **The repo's test discipline forbids real I/O in the unit suite** (CLAUDE.md golden rules; unit
   tests inject `gh`/harness/worktree fakes and make zero real network/git/subprocess calls).
2. **A live pilot is inherently non-hermetic and non-repeatable** — its value is precisely that it
   ran against a real GitHub repository with a real human merge.

These pull in opposite directions, so the pilot is defined with **two verification tiers** rather
than forcing one to serve both purposes.

## Decision 1 — Two tiers: hermetic composition simulation + live-pilot runbook

- **Tier 1 (CI-enforced): a hermetic composition simulation.** One end-to-end test drives the whole
  A → blocker → recovery/resume → merge-barrier → B → terminal sequence through the *existing*
  `SupervisorDeps` and `ReconcileObserveDeps` fakes. This proves the composed control flow — cycle
  ordering, single-active-item, barrier gating, resume marker, idempotency — deterministically, with
  zero real I/O, and can run forever in CI. It is the durable regression guard.
- **Tier 2 (one-time, human-run): a live-pilot runbook + evidence contract.** The actual live run
  cannot live in CI; instead the change pins *what the live run must do and capture*. The runbook is
  the reproducible procedure; the evidence-bundle contract is the falsifiable done-condition.

**Alternative rejected:** a single "integration test" that shells out to real `gh`/git. It would
violate the no-real-I/O rule, be flaky, and could not exercise a *human* merge — so it would prove
less than either tier while costing more.

## Decision 2 — Minimal fixture shape: exactly two dependent items

The fixture is the smallest run that forces every target behavior: two items where **B externally
depends on A**, under `max_active_items: 1`.

- Two items (not one) are required to exercise the **dependency gate** and the **merge-refresh
  barrier** — a barrier only exists between a producer and a consumer.
- The dependency edge plus single-active-item makes item selection deterministic (A must finish and
  be observed merged before B can start), which is exactly the merge-refresh barrier under test.
- Item A additionally carries the **recoverable-blocker + same-item-resume** leg, so one fixture
  covers all five behaviors without a third item.

A larger fixture would add cost without adding a distinct composition behavior; the issue explicitly
scopes a *two-item* pilot.

## Decision 3 — Barrier resolves from verified truth only

The merge-refresh barrier is not a timer or a caller assertion: item B is released **only** when a
reconciliation pass observes A's PR `merged` through the engine-owned observation seam
(`durable-run-reconciliation` / `durable-run-dependency-integrity`). The simulation asserts both
directions — B held while A is observed unmerged, B released on the first cycle after the merge
observation — and asserts that a caller claim of "A is merged" without a supporting live observation
does **not** release B. This keeps the pilot honest against the exact class of bug the reconciliation
capability exists to prevent (a caller-supplied claim driving a remote-proving transition).

## Decision 4 — Human owns A's merge; the pilot only observes it

Golden rule #4: the pipeline never merges. In the live pilot the human presses A's merge button; the
pilot's role is to *observe* that merge and clear the barrier. In the hermetic simulation this is
modeled by flipping the observation fake to report A's PR `merged` — never by the pilot issuing a
merge. The runbook makes the human merge an explicit, called-out step.

## Decision 5 — Evidence bundle is derived, not narrated

The pilot's evidence bundle references concrete recorded artifacts — item ledger history, the
action-evidence timeline (with the `resume` marker), sequence-numbered reconciliation records, the
merge observation that cleared the barrier, and the terminal condition — reusing the existing
`evidence-bundle` capability's projection rather than inventing a bespoke report. A reviewer verifies
the pilot by reading recorded truth. The simulation asserts each of the five behaviors is locatable
in the bundle; the live evidence bundle is the artifact linked from #515.

## Decision 6 — "No duplicate external action" is asserted from recorded writes

Idempotency is proven by counting the injected seam's external mutation calls across a replayed
cycle: a crash-and-resume and a redundant reconciliation over an already-`merged` item must record
**zero** additional writes (no duplicate PR, issue, label, or merge). This leans on the reconciliation
capability's "repair never mutates the remote" and the supervisor's single-authoritative-ledger
invariants, and turns them into an explicit composition-level assertion.

## Risks / trade-offs

- **The live tier cannot be CI-gated.** Mitigated by making Tier 1 the durable regression guard and
  Tier 2 a pinned, reviewable runbook + a linked evidence bundle on #515 — the done-condition is an
  artifact, not a claim.
- **Simulation could pass while masking a real integration gap.** Mitigated by Decision 3 (barrier
  from verified truth only) and the bite checks (task 6.3): each assertion is proven to fail when its
  behavior is defeated, so a green test means the behavior is actually exercised, not stubbed.
