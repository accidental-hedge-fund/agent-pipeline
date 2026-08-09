# Factory simplification (approved 2026-08-09)

Source of truth: `docs/factory-simplification-plan.md`  
Phase 1 OpenSpec: `openspec/changes/add-integrated-train-mode/`

## Phase 0 — Freeze and harvest

- [x] Evaluate pilot vs real objectives; approve simplification plan
- [x] Write durable plan doc (`docs/factory-simplification-plan.md`)
- [x] Scaffold OpenSpec change `add-integrated-train-mode` (proposal, design, specs, tasks)
- [x] Mark pilot plan superseded for startup (pointer from `docs/grok-supervised-factory-plan.md`)
- [ ] Do not expand `ops/hermes-factory` unless operator requests pilot recovery only
- [ ] Retriage GitHub issues (#901/#765 reshape; park #890-family) after plan PR lands

## Phase 1 — Integrated train mode (implement next)

- [ ] Validate OpenSpec change
- [ ] Implement `pipeline train` per `openspec/changes/add-integrated-train-mode/tasks.md`
- [ ] Unit tests for order, containment, isolation, resume, idempotent merge
- [ ] `npm run ci` green; PR to `main`
- [ ] Engine resume / ownership GC as required companion if still broken

## Phase 2 — Thin Hermes adapter

- [ ] Replace grant-JSON skill UX with intent → `pipeline train` / `pipeline single`
- [ ] Status heartbeat from train/loop JSON to Buzz
- [ ] Machine-local enable/expiry only (no 9-action grant product)

## Phase 3 — Release completion

- [ ] Authorized release finish after prepare-only `pipeline release`
- [ ] Keep FRG requirements for agent-pipeline self-release only as already configured

## Phase 4 — Self-host upgrade (optional)

- [ ] Pin promote / install / attestation isolation after trains work

## Explicit non-goals (do not start)

- #890 macro-controller as designed
- #899 privilege broker
- #907 MCP
- Growing hybrid FRG / factory journal authority
- `auto_merge` config key

## Review

### 2026-08-09 plan formalization

- Approved plan locked into `docs/factory-simplification-plan.md`.
- Phase 1 OpenSpec artifacts created under `openspec/changes/add-integrated-train-mode/`.
- Implementation not started in this session beyond planning artifacts.
