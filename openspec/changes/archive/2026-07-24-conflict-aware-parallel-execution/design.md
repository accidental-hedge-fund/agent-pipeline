## Context

Epic #528 is delivered mechanically by three shipped children:

| Concern | Capability | Issue |
| --- | --- | --- |
| Ownership + conflict model, pairwise `disjoint`/`conflict` evaluator | `durable-run-ownership-conflicts` | #529 |
| Deterministic budget-bounded independent-set scheduler, per-pass allow/deny record, global merge barrier, changed-file-overlap parking | `durable-run-independent-scheduler` | #530 |
| Hermetic composition simulation + live-pilot runbook/evidence-bundle | `durable-run-parallel-conflict-pilot` | #531 |

These sit on the already-shipped `durable-run-reconciliation` (#511), `durable-run-dependency-integrity`
(#513), `durable-loop-engine`/`durable-loop-supervisor` (#512), and `evidence-bundle`. The question this
design answers is: **what does the epic itself own, given the children already ship the parts?**

## Goals / Non-Goals

**Goals**

- State #528's four acceptance criteria as one **run-scoped integration contract** a reviewer can point
  to for "the run honored the epic," rather than inferring the composed guarantee from three specs.
- Pin a single durable **parallelization decision ledger** as the run-level answer to "why was each pair
  parallelized or serialized," derived from the scheduler's already-emitted per-pass records.
- Designate the #531 pilot as this capability's end-to-end acceptance vehicle.

**Non-Goals**

- No new engine feature, stage, decision path, or config key. The `concurrency` policy (#530) is the
  only knob; this change adds none.
- No change to any child requirement. The children's conservative defaults, determinism, and merge
  barrier are consumed as-is.
- No merge authority and no review relaxation (golden rule #4). The pipeline still stops at
  `pipeline:ready-to-deploy`.

## Decisions

### Decision: A new umbrella capability, not a modification of the children

The epic's guarantees are **cross-child run-level invariants** — "across the whole run, no unproven
pair is ever concurrent," "the merge barrier stays global for the whole run," "every decision is
durable evidence for the whole run." Each is a composition of behaviors that individually live in
#529/#530/#531 but that no single child asserts at run scope. Folding these into an existing child would
misattribute a run-level contract to a component and blur its tested boundary. A dedicated capability
keeps each child's altitude intact and gives the epic an owning spec — the same pattern epic #508 used
(a facade capability alongside its component capabilities).

*Alternative rejected:* extend `durable-run-independent-scheduler` with the run-level invariants. The
scheduler is a **per-pass pure decision**; the epic invariants are **whole-run accumulations** (a ledger
spanning many passes, "ever concurrent" across the run's lifetime). Different altitude, different tested
surface — keeping them separate avoids overloading the scheduler spec.

### Decision: A run-scoped ledger that accumulates, not a second decision path

The scheduler (#530) already emits a deterministic allow/deny planning record **per scheduling pass**,
each entry carrying exactly one structured reason from a closed set. The epic's first acceptance
criterion ("a durable run records why each pair was parallelized or serialized") is a **run-lifetime**
view: the union of those per-pass decisions, keyed by item pair, appended durably as the run advances.

The ledger therefore **accumulates and exposes** the children's records; it does not re-decide anything.
This is deliberate: introducing a parallel decision surface would risk drift from the scheduler's reason
set and re-derive conflict semantics the epic promised to consume, not re-implement. The ledger's reason
vocabulary is exactly the scheduler's closed set, drift-guarded the way the review schema is single-
sourced. Because it is pure accumulation over already-durable records, it is reconstructable from run
state alone and adds no external write path.

### Decision: The #531 pilot is the end-to-end acceptance vehicle

The composed guarantee is inherently an integration property — it cannot be proven by any child's
isolated unit test. #531 already defines the exact composition proof: a hermetic simulation driving
disjoint-concurrency → serialized-conflict → changed-file-overlap-park → serialized-merge through the
existing injected seams (zero real I/O), plus a live-pilot evidence bundle. This capability designates
that pilot as its acceptance vehicle rather than duplicating the simulation, and adds only the
run-scoped ledger assertions the pilot's evidence bundle must satisfy.

### Decision: Serialized-by-default is the observable invariant, not a mode

The run-level "no unproven pair runs concurrently" requirement is stated as an always-on invariant, not
a feature that turns on under a policy. With no `concurrency` policy the ledger records serial decisions
and behavior is byte-identical to today; with a policy, concurrency is admitted only for proven-disjoint
pairs. Framing it as an invariant (rather than "the parallel mode") means unknown overlap collapsing to
serial is a property the composition test asserts directly, in both the policy-absent and policy-present
cases.

## Risks / Trade-offs

- **Risk: the ledger and the scheduler's per-pass record drift.** *Mitigation:* the ledger reuses the
  scheduler's closed reason set verbatim and is populated from its emitted records; a test asserts the
  ledger's reasons are a subset of that set, so a new scheduler reason cannot silently bypass the ledger.
- **Risk: an umbrella capability reads as duplication of the children.** *Mitigation:* the spec deltas
  are strictly run-level (a ledger, whole-run invariants, an acceptance-vehicle designation) and cite the
  child capabilities as the mechanism; no per-pass, per-item, or evaluator requirement is restated.
- **Trade-off: the live-pilot leg is non-hermetic.** Accepted and bounded exactly as #531 does — the
  hermetic simulation proves the assertions bite in CI; the live run is a one-time captured evidence
  bundle linked from the pilot issue.

## Migration / Rollout

Fully additive. No migration: existing runs carry no `concurrency` policy, so every pair serializes and
the ledger records serial decisions — observable behavior unchanged. Concurrency is opt-in per run via
the existing #530 policy; nothing here changes single-item or freeform (non-OpenSpec) runs. Single-host
concurrency scope (#459) for the host-local `/tmp` locks is unchanged.
