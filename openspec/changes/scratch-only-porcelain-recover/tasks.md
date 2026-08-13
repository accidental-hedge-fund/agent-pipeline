## 1. Inventory porcelain dirt gates

- [ ] 1.1 Enumerate every production site under `core/scripts/` that can `setBlocked` (or equivalent park) based on worktree porcelain (`git status --porcelain`, dirty-trust, archive cleanliness, salvage path selection).
- [ ] 1.2 Record each site’s use of `classifyWorktreeDirt` / `productDirtyPaths` / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` (or mark as non-porcelain-dirt / explicit exception).
- [ ] 1.3 Note any site that still hard-blocks on scratch-only `artifacts/challenge-response-*.json` or other engine-known scratch with `needs-human` / `human-decision-required`.

## 2. Gate-time shared classification and unlink

- [ ] 2.1 Ensure every porcelain dirt gate from 1.1 classifies via the shared worktree dirt helper before deciding to `setBlocked`.
- [ ] 2.2 For scratch-only residual (product dirt empty): best-effort unlink/restore engine-known scratch and **do not** `setBlocked` (same spirit as marker-only cleanup).
- [ ] 2.3 Keep product / dirty `core/` / dirty product `openspec/` hard-blocks with path disclosure; do not waive broad `artifacts/**`.
- [ ] 2.4 Never auto-commit challenge-response / engine scratch into the product tree from dirt-gate cleanup.

## 3. Residual block kind

- [ ] 3.1 When an engine-scratch residual must still emit a block, use blocker kind `harness-failure` (projects `workflow-engine-defect`), never `needs-human` or `human-decision-required`.
- [ ] 3.2 Confirm stage-diagnostic projection maps that residual to recover disposition (not human-authority hold).
- [ ] 3.3 Leave true `human-decision-required` / product-dirt block kinds unchanged.

## 4. Recovery recipe (verify and close gaps)

- [ ] 4.1 Confirm default `workflow-engine-defect` recovery policy lists `unlink_engine_scratch` before `repair_pipeline_item` (and before any implementer harness repair).
- [ ] 4.2 Confirm `unlink_engine_scratch` unlinks only engine-known scratch, clears `pipeline:blocked` when product porcelain is empty, and does not open a harness round or commit on the candidate.
- [ ] 4.3 Confirm product dirt after unlink fails closed without a false “scratch recovered” clear.
- [ ] 4.4 Confirm successful mechanical recover does not mint a human hold or `human_intervention`.

## 5. Drift guard

- [ ] 5.1 Add a machine-readable inventory (or sealed disposition table) of porcelain dirt / `setBlocked` sites and whether each uses the shared classifier.
- [ ] 5.2 Add a unit drift-guard that fails when a new production porcelain dirt site is added without an inventory/disposition update.
- [ ] 5.3 Prove the guard bites (missing row → test fail) and passes with the inventoried sites.

## 6. Unit regressions

- [ ] 6.1 Scratch-only porcelain (`?? artifacts/challenge-response-N.json`) at each relevant dirt gate: no `setBlocked` / no `needs-human` solely for that dirt; gate proceeds or unlinks then proceeds.
- [ ] 6.2 Dirty `core/` and dirty product `openspec/` still hard-block with path disclosure (mixed with scratch does not waive product).
- [ ] 6.3 Recovery unit test: scratch-only → `unlink_engine_scratch` + clearBlocked + **no** `repair_pipeline_item` (extend existing `pipeline-recovery-executor` coverage if already present).
- [ ] 6.4 Policy order unit test: default `workflow-engine-defect` recipes place `unlink_engine_scratch` ahead of `repair_pipeline_item`.
- [ ] 6.5 Residual engine-scratch block kind unit test: `harness-failure`, not `needs-human` / `human-decision-required`.
- [ ] 6.6 All unit tests stay injectable (no real git/network/subprocess).

## 7. Mirror, validate, CI

- [ ] 7.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 7.2 Run `openspec validate scratch-only-porcelain-recover` (and `openspec validate --all` as needed) until clean.
- [ ] 7.3 Run `npm run ci` from the repo root and fix failures until green.
