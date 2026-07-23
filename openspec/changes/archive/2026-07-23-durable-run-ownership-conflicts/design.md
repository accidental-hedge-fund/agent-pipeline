## Context

Epic #528 adds conflict-aware parallel execution to integrated `pipeline:loop` runs. Its safety model
is a three-part disjointness proof for any candidate pair — **dependency**, **declared ownership**, and
**shared surface** — with a hard conservative default: *unknown overlap means serialize*. The durable
engine (`core/scripts/loop/`) already owns the dependency third (`durable-run-dependency-integrity`,
#513) but has **no** representation of ownership or surface conflict. #529 is the first child: it
supplies the model and the deterministic evaluation the planner (#530) will consume. #529 deliberately
stops short of scheduling — no worktree is allocated, no item is parallelized here.

Two structural facts shape the design:

- A **source tree** has disjoint sub-regions: two items owning non-overlapping path globs genuinely do
  not collide, so exclusive-ownership surfaces conflict **only on glob overlap**.
- A **shared surface** (a lockfile, a generated schema, `.github/workflows/ci.yml`, a public API
  surface, a version file) has **no** disjoint sub-region: any two items that both touch it can race to
  regenerate/rewrite it, so shared surfaces conflict **by default**. This asymmetry is the core of the
  model and is why the two surface kinds carry different conflict classes.

## Goals / Non-Goals

**Goals**
- A validated, machine-readable per-item ownership + conflict declaration.
- Deterministic normalization of declared surfaces into a typed, comparable set.
- A pure, deterministic pairwise evaluator returning `disjoint`/`conflict` with a structured reason.
- Conservative-by-construction: unknown ownership ⇒ conflict; shared surface ⇒ conflict unless a
  reviewed exception.
- Durable planning evidence (normalized set + reason) — the epic's "record why each pair was
  parallelized or serialized."

**Non-Goals**
- The parallelization **planner/scheduler** that turns pairwise verdicts into a concurrent schedule,
  and worktree allocation (#530).
- Execution-time **changed-file** overlap detection and parking of racing work (#530/#531) — this
  change reasons over *declared* surfaces, not observed diffs.
- Populating declarations automatically from issue bodies / labels. #529 defines the model and its
  semantics; where declarations originate (intake, manual authoring, future discovery) is out of scope.
- Any merge / review-gate interaction (golden rule #4). The evaluator is read-only and grants nothing.

## Decisions

### Declaration lives on the contract item, additive and empty-defaulting

The declaration attaches to `LoopContractItem` as an optional `ownership` field, mirroring how
`external_depends_on` was added additively in `durable-run-dependency-integrity`. Absent/empty ⇒
**unknown ownership** ⇒ conflict. This keeps every existing durable run behaving exactly as today (all
pairs unknown ⇒ all serialized) until ownership is actually declared, so the change ships dark and safe.

### Two surface classes, one asymmetry

`exclusive` surfaces (source path/module globs) conflict iff globs overlap. `shared` surfaces
(schema/state, generated artifact, shared config, public API, CI/workflow, package/version) conflict
iff both items own the *same* surface. Modeling the class explicitly on each normalized entry — rather
than inferring it at compare time — keeps the evaluator a simple, testable fold and makes the evidence
self-describing.

### Reviewed exceptions suppress only auto-derived shared conflicts

An `exception` is `{ surface, justification, review_ref }`. It suppresses the **shared-surface**
conflict it names for a pair — nothing else. It cannot suppress an explicit `conflicts_with` edge (a
human's direct "these fight" is stronger than a human's "these are fine"), and it cannot suppress an
unknown-ownership conflict (there is no named surface to except). Requiring `justification` +
`review_ref` at the schema layer makes every exception auditable and keeps the "unless an explicit
reviewed exception exists" rule from #529 concrete and falsifiable.

### Evaluation order is fixed and total

`evaluateConflict` checks causes in a fixed precedence so the reason is deterministic and singular:
1. explicit `conflicts_with` edge → `conflict` (explicit_edge) — never suppressible;
2. unknown ownership (missing declaration or uncovered surface) → `conflict` (unknown_ownership);
3. co-owned shared surface with no valid exception → `conflict` (overlapping_surface, shared);
4. overlapping exclusive globs → `conflict` (overlapping_surface, exclusive);
5. otherwise → `disjoint`.

Fixing the order guarantees the same pair always yields the same single-cause reason, satisfying the
determinism criterion and giving the planner a stable signal to cite in evidence.

### Purity and the repo test seam

Normalization and evaluation are pure functions over in-memory declarations — no gh, git, or fs. This
matches the repo discipline (`AdvanceReviewDeps`/`VerifyDeps`-style injected seams; unit tests do no
real I/O) and lets #531's integration tests layer real evidence on top without re-testing the core
algebra. Glob semantics are pinned by a test rather than assumed, per golden rule #5 (verify shapes).

## Risks / Trade-offs

- **Over-conservatism.** Everything unknown/shared conflicts, so early runs parallelize little. This is
  intended — #528's rule is "unknown overlap means serialize" — and is loosened only by *declaring*
  ownership, not by weakening the default.
- **Glob-overlap correctness.** Deciding whether two globs can match a common path is the subtle part;
  a wrong "disjoint" is unsafe. Mitigation: a conservative matcher (treat undecidable overlap as
  overlapping) plus exact-path and glob-overlap tests that bite.
- **Declaration drift vs. reality.** A declaration can under-state what an item actually touches; #529
  reasons over declarations only. #530/#531 add execution-time changed-file overlap detection and
  parking as the backstop — called out here so the boundary is explicit, not silently assumed away.
