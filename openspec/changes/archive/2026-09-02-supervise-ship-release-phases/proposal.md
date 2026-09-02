## Why

The durable issue supervisor ends at `pipeline:ready-to-deploy`. After that, `pipeline ship` persists a failed phase and rethrows, while release, tag, finish, promotion, deployment, and rollback still use command-local failure semantics. Ship also infers human authority from error-message regex. Those paths leave ownerless thrown failures, stale authorization, and unverified live artifacts.

## What Changes

- Make every post-ready ship phase a typed, exact-candidate operation under RecoverySupervisor. Ship status remains a compatibility projection, not a second controller.
- Represent exactness as Candidate Lineage: integrated base candidate → FRG candidate → release PR head → release merge result → tag → published artifact → promoted pin → deployed artifact and environment. Each edge has its own observer and invalidation rule.
- Reconcile before and after mutation. Stable claims bind operation, repository, lineage node, scope, actor, and expiry.
- Keep a failed phase active, cooling, or waiting. Mechanical failure MUST NOT become an ownerless thrown failure.
- Stop inferring authority from error-message regex. Preserve only current operation-bound authority. Candidate movement invalidates stale authorization and verification evidence.
- Prove deployment by the authorized artifact digest being live. A version string is not enough.
- Make rollback a separate protected operation. Automatic rollback requires an authenticated envelope that names the exact rollback operation and retained target. Generic deployment failure grants no rollback authority.
- Interpret `#1024`'s single `roadmap.release_model` policy: continuous completes when exact-candidate integration is proven; SemVer executes only its applicable FRG, release, tag, publication, promotion, and deployment phases.
- Keep Factory Reliability Gate (FRG) and release-integrity gates enforced.
- Cover every external ship-path side effect with a fresh-process crash test.

## Capabilities

### New Capabilities

- `supervised-ship-phases`: post-ready release, tag, publication, promotion, deployment, and rollback as RecoverySupervisor-owned exact-candidate operations with Candidate Lineage, durable claims, reconciliation, operation-bound authority, and crash-safe replay.

### Modified Capabilities

- `ship-coordinator`: ship status is a compatibility projection of RecoverySupervisor lifecycle; failed phases remain owned; `human_authority` is a typed projection, never error-message regex; `roadmap.release_model` selects applicable phases.
- `engine-promote`: promotion and deployment prove the authorized candidate digest is live; generic install or verify failure does not grant rollback authority.
- `factory-two-track-engine-pinning`: automatic pin rollback requires an authenticated envelope naming the exact rollback operation and retained target.

## Impact

- **Reuse first:** extend `core/scripts/stages/ship.ts` (`runShipCoordinator`, `persist`, reconcile/converge seams), `core/scripts/stages/ship-adapter.ts`, `core/scripts/stages/engine-promote.ts`, `core/scripts/production-engine-pin.ts` (`rollbackProductionPin`), `core/scripts/stage-diagnostic.ts` (`projectStageDiagnostic`), `core/scripts/loop/recovery.ts` (Cooling, claims, strategy cursor), `core/scripts/loop/reconcile.ts`, and existing `roadmap.release_model`. Do not add a second RecoverySupervisor, ship controller, grant schema, or scheduler.
- **Class vs site:** ownerless post-ready failure, regex-inferred authority, and auto-rollback on generic deploy failure are one ship-phase supervision class. The next identical fault on any post-ready phase uses these claims and observers. Do not file a per-phase mole.
- **CLI:** no new public ship verb. `pipeline ship`, `pipeline ship status`, `pipeline release`, `pipeline engine-promote`, and `pipeline factory-pin rollback` remain the surfaces. Advance, single, and loop still stop at ready-to-deploy.
- **Hosts:** adapters keep reading typed ship status. Observational event delivery cannot become lifecycle authority.
- **Tests:** hermetic unit tests inject gh/git/install/pin/observer fakes. Fresh-process crash fixtures cover every external ship-path side effect. No real network, git, or subprocess in unit tests.
- **Docs:** keep `CONTEXT.md` terms (RecoverySupervisor, Candidate lineage, Cooling, Exact-candidate recovery). Align CLI and ship docs. Run `node scripts/build.mjs` after `core/` edits.
- **Sequencing:** consumes RecoverySupervisor (#1323) as sole lifecycle owner and `#1024` `roadmap.release_model` as the single shipment-intent policy. Does not reimplement #1330 merge exactness, #1332 liveness, or #1333 matrix ownership.

## Acceptance Criteria

- [ ] Every post-ready ship phase (release, tag, finish, publication, promotion, deployment, rollback) declares explicit preconditions, postconditions, and an authoritative observer.
- [ ] Those phases persist durable claims and reconcile live external truth before retry. A completed side effect is not replayed.
- [ ] A failed phase remains active, cooling, or waiting. Ship does not persist failure and rethrow as an ownerless terminal.
- [ ] `pipeline ship` does not set `human_authority` from error-message regex. Authority is a typed request or diagnostic projection.
- [ ] Authority survives safe retry only while operation, repository, candidate, scope, actor, and expiry remain valid.
- [ ] Candidate movement invalidates stale authorization and verification evidence for that lineage node.
- [ ] Deployment completion proves the authorized candidate digest is live. A version string alone does not complete the phase.
- [ ] `roadmap.release_model: continuous` completes when exact-candidate integration is proven and does not execute SemVer-only phases.
- [ ] `roadmap.release_model: semver` executes only applicable FRG, release, tag, publication, promotion, and deployment phases.
- [ ] FRG and release-integrity gates still fail closed. This change does not add `--skip-frg` as the default and does not bypass tag or publication proof.
- [ ] Automatic rollback does not run from generic deployment or install failure. Rollback runs only with an authenticated envelope naming the exact rollback operation and retained target.
- [ ] Fresh-process crash tests cover every external ship-path side effect (release PR, merge, tag, publication, pin, install, rollback).
- [ ] Advance, single, and loop still stop at `pipeline:ready-to-deploy` and never merge or deploy.
- [ ] Observational event delivery does not change lifecycle.
- [ ] No second RecoverySupervisor, ship controller, grant schema, or scheduler is introduced.
- [ ] `npm run ci` passes. After `core/` edits, `node scripts/build.mjs --check` passes.
