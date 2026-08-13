## Context

See `proposal.md` for motivation. Constraints that shape the approach:

- **Golden rule #4:** advance / single / loop never merge. Merge stays on operator-authorized `pipeline merge` (and train’s optional `--merge` merge wave that calls that surface).
- **Loop already owns** multi-item recovery, resume, ownership/conflict co-advance, and `max_concurrent_worktrees` (#528–#531). Train must consume that brain, not copy it.
- **Worktrees branch from `origin/<base_branch>`**, not from sibling PR heads. Code-stacked `Depends on` therefore needs an **integrate barrier** (merge + containment on base) before the child advances.
- **Living law** under `integrated-train-mode` already describes frontier waves (from epic #1028 archive). This change is the focused #1023 implement/verify contract: production composition, call-shape tests, and any remaining behavioral gaps.
- **Tugboat ship** is `train --merge` + release; no playbook fork for composition.

## Goals / Non-Goals

**Goals:**

- One shared advance brain: train schedules base-eligible frontiers; loop recovers and co-advances within a frontier.
- Preserve squash-aware merge-result containment as the integrate proof between waves.
- Fail closed on unproven independence (deps + ownership/conflict ledger).
- Keep merge serial and outside loop.
- Injectable deps so unit tests assert wave call shape without network/git/subprocess.

**Non-Goals:**

- All-milestone one-shot loop then single merge wave.
- PR stacking / branching child off parent PR head.
- Parallel merges or parallel `engine-promote`.
- Softening ownership so unproven pairs co-advance.
- Auto-merge without `--merge` / operator authority; `auto_merge` config; merge inside loop.
- Threshold → general LLM recover; second train-local recoverer.
- Hermes/Buzz-only orchestration; continuous `ship_model` (#1024).
- Reimplementing loop recovery recipes (#1020 / #1025) inside train.

## Decisions

### 1. Two-wave facade, not N×`single` and not one giant loop

**Choice:** For each iteration: compute frontier → one multi-item advance wave → optional serial merge wave → recompute.

**Why over pure N×`single`:** reuses loop recovery and parallel disjoint advance; removes whole-train STOP on the first parked item when independent work remains.

**Why over “loop entire milestone then merge all”:** code-stacked children need parent commits on base before their worktrees are useful.

**Alternatives rejected:** Graphite/stack-aware child branches from parent head (out of scope; breaks configured base model).

### 2. Frontier eligibility = base-integrated code prereqs + co-advance rules

**Choice:**

- Code dependency (default when edge kind is unknown): parent’s merge-result must be contained in the fetched configured base tip before the child enters a frontier.
- Schedule-only edges (if/when declared) may omit the code barrier; unknown → fail closed as code dep.
- Co-advance within a frontier follows loop ownership/conflict rules; unknown overlap serializes.

**Why:** Matches worktree base model and existing durable-run conflict pilot semantics.

### 3. Injected `advanceWave` seam; production wires loop engine

**Choice:** Train orchestrator depends on an injected multi-item `advanceWave(issues)` (or equivalent). Production `runTrainCommand` / ship train path supply a function that runs the durable loop engine once for that frontier work list. Tests inject fakes that record call shape.

**Why:** Unit tests prove “one call per frontier” without spinning loop. Production cannot silently fall back to N×`single`.

**Adapter note:** A serial wrapper around single-item advance may exist for tests/legacy adapters only; production CLI and ship paths MUST NOT use it as the default wiring.

### 4. Merge wave ownership stays in train

**Choice:** Only `--merge` runs a merge wave after an advance wave, for frontier members at ready-to-deploy that are not already integrated. Merges are one-at-a-time with fetch + containment between them. Train never merges inside the advance wave.

**Why:** Preserves golden rule #4 and existing `pipeline merge` gates.

### 5. Partial failure continues for proven-independent R2D siblings

**Choice:** Parked/blocked item is held (not merged). If another R2D sibling has no dep edge involving the held item and independence is proven from declared deps and ownership/conflict ledger, the merge wave MAY merge the sibling. If independence cannot be proven, fail closed (do not merge under the independent-sibling rule).

**Why:** Whole-train STOP on one engine mole defeats ship autonomy when peers are ready and independent.

### 6. Recovery remains loop-only inside the advance wave

**Choice:** Train does not call `repair_pipeline_item` or host a second recoverer. Engine moles that are recoverable under loop recipes heal during the advance wave when those recipes are present (#1020 / #1025 are soft ship companions, not hard build deps of this composition).

## Risks / Trade-offs

- **[Risk] Production still exposes N×`single` somewhere (CLI, ship, thin adapter)** → Mitigation: unit/source tests assert multi-item loop wiring; forbid production `advanceWaveFromSingle` default.
- **[Risk] Frontier misclassifies a code dep as schedule-only** → Mitigation: unknown edge kind fails closed as code dep.
- **[Risk] Independent-sibling merge races a real dep that was not declared** → Mitigation: fail closed without proven independence; operators must declare `Depends on` for code stacks.
- **[Risk] Infinite frontier recompute if base never moves** → Mitigation: held/error terminals exclude items; wave budget / stop when no frontier progress.
- **[Trade-off] Serial merges slow large independent batches** → Accepted; parallel merges and parallel promote are non-goals.
- **[Trade-off] Soft dependency on recover recipes for green dogfood ships** → Composition lands with tests; live ship still benefits from #1020 / #1025.

## Migration Plan

1. Land frontier orchestration + injected advance-wave seam with unit tests (call shape, A→B containment, independent merge, concurrency 1).
2. Wire production `runTrainCommand` and ship train path to multi-item loop advance.
3. Keep CLI flags (`--merge`, `--milestone`, `--issues`) and Tugboat calling `train --merge`.
4. Regenerate `plugin/` if `core/` changes; `npm run ci` green.
5. Rollback: revert the PR; prefer forward-fix of frontier bugs over restoring N×`single` as permanent behavior.

## Open Questions

None that block specs or task breakdown. Schedule-only edge kind remains optional future grammar; until declared, unknown fails closed as code dep.
