## 1. Candidate Lineage and operation invariants

- [x] 1.1 Extend ship progress evidence with Candidate Lineage nodes (integrated candidate, FRG candidate, release PR head, merge result, tag, published artifact, promoted pin, deployed digest) and per-edge observers, and verify a unit test round-trips those identities without collapsing them to a version string
- [x] 1.2 Declare explicit precondition, postcondition, observer, candidate binding, and replay rule for release, tag, finish, publication, promotion, deployment, and rollback, and verify a missing observer proof cannot complete that phase
- [x] 1.3 Keep `pipeline ship` as the compatibility projector over RecoverySupervisor observations (no second controller or ledger family), and verify ship status JSON still names phase, candidate, and next action without performing mutations

## 2. Owned failure and typed authority

- [x] 2.1 Stop `persist()` from setting `human_authority` via error-message regex, and verify a fixture that throws `needs-human: missing-authority...` without a canonical diagnostic leaves `human_authority` false
- [x] 2.2 Project `human_authority` only from a current typed Authority Request or `projectStageDiagnostic` disposition, and verify a canonical human-authority diagnostic still sets the status bit
- [x] 2.3 Replace persist-and-rethrow with owned Cooling or external-condition wait for mechanical post-ready faults, and verify `runShipCoordinator` returns resumable status instead of an ownerless thrown terminal
- [x] 2.4 Claim each post-ready mutation before the side effect and reconcile after crash, and verify a `started` claim plus process death does not create an uncharged replay
- [x] 2.5 Invalidate operation-bound authority and verification when operation, repository, candidate, scope, actor, or expiry no longer match, and verify candidate movement refuses the stale grant

## 3. Release-model policy

- [x] 3.1 Read the existing `config.roadmap.release_model` in the ship coordinator (no `ship.model` key), and verify continuous vs semver fixtures resolve from that single key
- [x] 3.2 Complete a continuous ship when exact-candidate integration is proven, and verify release, tag, publication, promotion, and deployment converge functions are not invoked
- [x] 3.3 Keep SemVer post-train FRG, release, tag, publication, promotion, and deployment, and verify FRG and release-integrity gates still fail closed without `--skip-frg`

## 4. Deployment digest and protected rollback

- [x] 4.1 Prove engine-promote deployment by live installed digest matching the authorized published artifact, and verify a matching version string with a wrong digest does not complete
- [x] 4.5 Reload the production pin after live-host digest observation and refuse verified deployment when the pin identity moved, and verify a same-version retarget between pin read and host observation stays owned
- [x] 4.2 Remove auto-rollback and previous-tag reinstall from engine-promote install/verify failure paths, and verify those paths do not call `rollbackProductionPin`
- [x] 4.3 Keep `pipeline factory-pin rollback` as the rollback mutation under RecoverySupervisor, and verify automatic rollback without an envelope naming the operation and retained target is refused
- [x] 4.4 Document that generic deployment failure grants no rollback authority, and verify CLI / FRG runbook copy does not tell engine-promote to roll back on install failure

## 5. Fresh-process crash coverage

- [x] 5.1 Add injected fresh-process crash fixtures for train merge, FRG pack/attest, release PR create, and release merge, and verify each completed side effect is not replayed
- [x] 5.2 Add injected fresh-process crash fixtures for tag push, GitHub Release publication, pin write, host install, and rollback, and verify unproven postconditions remain owned
- [x] 5.3 Confirm crash tests perform no real network, git, or subprocess, and verify they fail if those I/O seams are used

## 6. Docs, packaging, and CI

- [x] 6.1 Align `CONTEXT.md`, CLI docs, and ship docs with Candidate Lineage, owned Cooling, typed authority, digest deployment, and protected rollback, and verify those surfaces do not describe regex authority or auto-rollback on install failure
- [x] 6.2 After any `core/` edit run `node scripts/build.mjs` and verify `node scripts/build.mjs --check` passes
- [x] 6.3 Run `openspec validate supervise-ship-release-phases` and `openspec validate --all`, and verify both exit 0
- [x] 6.4 Run `npm run ci` from the repo root, and verify the full gate passes
