## Context

See `proposal.md` for motivation and dogfood evidence (#1013 / PR #1016, train ship-v1.38.0).

**Already landed (epic #1028 / living `engine-scratch-recover`):**

- Shared classifier `classifyWorktreeDirt` / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` in `core/scripts/worktree-dirt.ts` (format/test gates via #873 / #1013; pre-merge archive via #1017).
- Recovery action `unlink_engine_scratch` in the recovery executor; default `workflow-engine-defect` recipes: `unlink_engine_scratch` → `restart_workflow_engine` → `repair_pipeline_item`.
- Unit coverage in `pipeline-recovery-executor.test.ts` and loop-supervisor recovery order checks.

**Still the #1020 contract (this change):**

- Gate-time “unlink and do not `setBlocked`” is universal for every porcelain dirt gate — not only recovery after a false park.
- Residual engine-scratch blocks (when a block must still emit) use `harness-failure` → `workflow-engine-defect`, never `needs-human` / `human-decision-required`.
- Drift guard so a new porcelain/`setBlocked` dirt site cannot bypass the shared classifier without inventory update.
- Close any remaining site that still parks scratch-only as `needs-human` (path-shaped moles after #1017).

Product dirt and true human authority are out of scope for reclassification.

## Goals / Non-Goals

**Goals:**

- One shared dirt model at every porcelain → block decision.
- Scratch-only never parks as human and never contaminates the candidate with implementer repair commits.
- Residual engine defects stay on the recover path (`harness-failure` / `workflow-engine-defect`).
- Drift guard stops the next undeclared dirt site.
- Keep product / dirty `openspec/` / dirty `core/` fail-closed.

**Non-Goals:**

- LLM classification of human vs engine.
- Patching engine source into the blocked item's PR.
- Auto-merge, release, credentials, overrides.
- Changing #538 milestone policy (#1021) or train frontier composition (#1023).
- Broad `artifacts/**` waiver.
- Threshold → general LLM recover for arbitrary blocks.
- Reworking product-dirt block kinds (those may remain `needs-human` / workspace-dirt).

## Decisions

### D1: Shared classifier is the only porcelain dirt model

**Decision:** Every production dirt gate that can `setBlocked` on porcelain MUST call `parsePorcelainPaths` + `classifyWorktreeDirt` / `productDirtyPaths` (or a thin wrapper that is the sole consumer of `ENGINE_NON_PRODUCT_SCRATCH_GLOBS`). No parallel hard-coded scratch basename lists at call sites.

**Rationale:** #1013 fixed format/test; #1017 fixed archive; dogfood failed because one site lagged. Parallel lists re-create the mole.

**Alternatives:** Extend each gate’s local strip list (rejected: drifts). Broad `artifacts/**` ignore (rejected: non-goal).

### D2: Gate-time unlink + no block for scratch-only; recover for leftovers

**Decision:**

1. At dirt gates: if product dirt is empty, best-effort unlink/restore engine-known scratch (same spirit as marker-only cleanup), then proceed without `setBlocked`.
2. If a historical leftover already has `pipeline:blocked` from scratch-only evidence, loop recovery runs `unlink_engine_scratch` first: unlink → `clearBlocked` when product porcelain is empty → resume current stage. No harness round. No product commit.

**Rationale:** Prevention (gate) plus cure (recipe) covers both first-hit and resume after a false park.

**Alternatives:** Only prevent `setBlocked` without recover (incomplete for already-blocked items). Only recover without gate fix (keeps minting parks and burning budget).

### D3: Residual engine block kind is harness-failure

**Decision:** When an engine-scratch residual still must `setBlocked` (status probe failure, cleanup failure, non-product factory defect framed as scratch residual), use `harness-failure` so `stage-diagnostic` projects `workflow-engine-defect` with disposition recover. Never `needs-human` (projects `workflow-state` and can STOP train as a false human hold narrative) and never `human-decision-required` (true authority).

**Rationale:** Issue statement: true human authority is already a closed class; `needs-human` is not authority but still parks operators and train.

**Alternatives:** Keep `needs-human` and teach train to ignore it (rejected: wrong semantics). New `BlockerKind` solely for scratch (possible later; `harness-failure` already maps correctly).

### D4: Drift guard inventory for porcelain dirt sites

**Decision:** Add a small inventory (JSON/TS const, co-located with tests or next to escalation inventory) of production porcelain → `setBlocked` sites with a disposition field such as `uses-shared-classifier` | `not-porcelain-dirt` | `explicit-exception`. A unit test discovers call sites (static scan of porcelain + setBlocked patterns, or a sealed list of known modules that must declare rows) and fails on missing rows.

**Rationale:** Mirrors `escalation-site-dispositions` success pattern for setBlocked kinds; stops the next undeclared path.

**Alternatives:** Code review only (rejected: dogfood already proved review misses). Force every dirt check through one function that always classifies (good long-term; inventory still documents exceptions).

### D5: Spec surface

**Decision:**

- **MODIFIED** `engine-scratch-recover` requirements for gate-time shared classification + unlink, and recipe naming/`workflow-engine-defect` order.
- **ADDED** residual `harness-failure` and porcelain drift-guard requirements under `engine-scratch-recover`.
- **MODIFIED** `autonomous-recovery-controller` engine-scratch recover requirement to pin `unlink_engine_scratch` before `repair_pipeline_item` in default policy.
- **ADDED** `test-gate-non-product-dirty` requirement that format/test scratch-only never mintes `needs-human`.

No new capability name; living capability already exists from epic #1028.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Unlink deletes operator work under `artifacts/` | Only engine-known globs; never entire `artifacts/**`; product paths still block |
| Residual `harness-failure` mis-applied to product dirt | Requirement scopes residual to engine-scratch class; product dirt keeps existing kinds |
| Drift guard false positives on non-dirt setBlocked | Inventory dispositions include `not-porcelain-dirt`; scan must be porcelain-coupled |
| Double work vs epic #1028 implementation | Tasks prefer verify-and-close-gaps: re-use existing recipe/tests; add only missing gates/guard/kind |
| Stale plugin mirror | tasks require `node scripts/build.mjs` with `core/` edits |

## Migration Plan

1. Land this OpenSpec planning change (no application code in the planning commit).
2. Implement / verify: inventory dirt gates; fix any site still parking scratch-only as `needs-human`; pin residual kind; add drift-guard test; keep/extend recovery unit tests.
3. Regenerate `plugin/` when `core/` changes; `openspec validate`; `npm run ci`.
4. Archive at pre-merge into living specs (merge MODIFIED/ADDED into `engine-scratch-recover` and siblings).

Rollback: revert the implement PR; recovery falls back to prior recipe order only if the whole recipe change is reverted — prefer forward-fix of residual sites.

## Open Questions

None that block specs or task breakdown. Whether the drift inventory lives as a dedicated `*.inventory.ts` or extends an existing inventory file is an implementation detail as long as CI fails on undeclared porcelain dirt sites.
