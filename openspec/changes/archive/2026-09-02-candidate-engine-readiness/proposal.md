## Why

Ship and hybrid-v2 Layer A collection can select an exact-SHA candidate engine root that is not runnable. The first candidate command then fails because candidate `core/node_modules` is missing. The v1.40.0 ship against SHA `385bf89f3cfb220e2e3a40abc333496fb3fca091` is one site of that class: every accepted resolution source can return a root that is not yet runnable.

## What Changes

- Add one shared asynchronous **resolve-and-prepare** gate on the existing candidate-engine controller. The gate validates exact SHA and tracked cleanliness, bootstraps from the nested candidate `core/package-lock.json`, revalidates SHA and cleanliness, and only then returns a root that callers may spawn.
- Serve the ship coordinator and hybrid-v2 Layer A collection through that same seam. Tugboat invokes the same gate before candidate CLI spawn. Leaf candidate invocations inherit the guarantee and do not self-heal. The general installed launcher does not gain candidate self-healing.
- Prove readiness with an engine-owned success record stored outside tracked files, keyed by candidate SHA and the nested `core/package-lock.json` digest. A `core/node_modules` directory alone is not proof. Repository `setup_command` cannot skip or replace this readiness.
- Serialize setup by canonical candidate root and SHA with child-safe ownership. Concurrent consumers share one install. Parent-PID death does not reclaim the lock. Abandoned ownership fails closed.
- Fail closed before spawn with candidate-local remediation text. Do not recommend a global package reinstall.
- Document the candidate-readiness contract on the operator-facing ship and candidate-engine surface. Keep CONTEXT.md terms `candidate-engine-root`, `candidate-readiness`, and `resolve-and-prepare`. Do not add a new CLI verb.

## Capabilities

### New Capabilities

- `candidate-engine-readiness`: Shared pre-spawn gate that makes every accepted candidate-engine root runnable. Covers SHA-plus-lockfile-digest proof, nested-core bootstrap, child-safe serialization, fail-closed recovery, spawn ordering, and injected-I/O regression coverage.

### Modified Capabilities

- `ship-end-candidate-engine`: Ship-end composers SHALL obtain a runnable candidate root from the shared resolve-and-prepare seam before the first candidate-engine command. Identity-only resolution is no longer sufficient to spawn.
- `ship-coordinator`: In-engine `pipeline ship` SHALL call that asynchronous seam after train-complete and SHALL NOT spawn leaf ship-end verbs until readiness succeeds. Setup, lock, and abandoned-ownership failures remain supervised lifecycle states (bounded treatment, Cooling, or External-condition wait), not generic blocked, needs-human, or a new recover recipe.
- `tugboat-thin-ship`: After train-complete, Tugboat SHALL invoke the same resolve-and-prepare seam before candidate CLI spawn. Tugboat SHALL NOT reimplement candidate install in bash and SHALL NOT fall back to the production pin when setup fails.
- `factory-reliability-gate`: Hybrid-v2 Layer A collection SHALL resolve and prepare the packed-candidate engine through the same seam before TAP. Collect SHALL fail closed before probes when readiness fails.

## Impact

- **Reuse (first holding rung):** Keep `resolveCandidateEngine` in `core/scripts/ship-end-candidate.ts` as the SHA and cleanliness selector. Wrap it with one asynchronous prepare step. Point existing injectables in `core/scripts/stages/ship-adapter.ts` and `core/scripts/frg-hybrid-v2-from-run.ts` at that wrapper. Do not invent a second source list. Do not reuse `detectAndInstall` from `core/scripts/worktree-setup.ts` as the candidate gate (`setup_command` can skip it; `node_modules` presence is treated as ready). Do not reuse `PipelineLock` reclaim-on-dead-PID as the setup lock.
- **Engine:** Candidate bootstrap, readiness record, and child-safe lock live outside tracked candidate files. Nested install CWD is candidate `core/` from that SHA's `core/package-lock.json`.
- **Composers:** Tugboat calls the pin-side TypeScript seam before `SHIP_END_CLI` spawn. No new CLI verb. No plugin SKILL rewrite as the product change.
- **Docs:** `docs/runbooks/ship-milestone.md`, supervisor candidate-engine notes, CONTEXT.md terms already landed.
- **Tests:** Injected I/O only. No real network, git, or npm in unit tests. Cover every selection source, partial-install retry, setup failure, concurrent wait, abandoned ownership, nested-core lockfile, post-bootstrap dirtiness, and spawn ordering.
- **Does not:** weaken exact-SHA or clean-worktree checks; reinstall the globally installed pipeline package; change ordinary issue-worktree bootstrap; move bootstrap into the general launcher; add extra supply-chain gating or operator attestation; auto-reclaim on parent-PID death; add a new CLI verb; add `auto_merge`, a merge stage, or a special ship of the readiness gate.

## Acceptance criteria

- [ ] Every supported candidate resolution source (clean `REPO_DIR`, existing ship-candidate worktree, `PIPELINE_CANDIDATE_ENGINE_ROOT`, newly created candidate worktree) yields a runnable candidate engine before the first candidate-engine command is spawned.
- [ ] One asynchronous resolve-and-prepare seam serves the ship coordinator and hybrid-v2 Layer A collection. Tugboat uses that same seam. Leaf candidate invocations do not spawn first. The general installed launcher does not self-heal a missing candidate install.
- [ ] The seam validates exact SHA and tracked cleanliness, proves candidate readiness, revalidates exact SHA and tracked cleanliness, and only then returns a root that callers may spawn.
- [ ] Engine bootstrap installs from the nested candidate `core/package-lock.json` into that candidate `core/` directory. It does not install from a different lockfile.
- [ ] Repository project `setup_command` cannot skip or replace engine runtime readiness.
- [ ] Presence of `core/node_modules` alone does not count as ready. An unmarked pre-existing or partial install is not trusted.
- [ ] Proof of readiness is an engine-owned success record stored outside tracked files, keyed by candidate SHA and the nested `core/package-lock.json` digest.
- [ ] A matching SHA-plus-digest record skips a new install.
- [ ] Missing, stale, or partial readiness causes exactly one serialized install in that candidate `core/` from that lockfile.
- [ ] Concurrent consumers of the same canonical root and SHA perform one install. Waiters reuse that result and observe bounded heartbeats from the live installer.
- [ ] Setup failure prevents candidate spawn, writes no success record, names the exact candidate path, and instructs candidate-local remediation in that candidate `core/`. It does not recommend a global package reinstall. When the lock is the cause, the report also names owner and process information.
- [ ] Exact SHA and tracked cleanliness are validated before bootstrap and again after bootstrap. A mismatch fails closed.
- [ ] Locks and readiness records are not stored inside the tracked candidate worktree.
- [ ] Ownership is child-safe. Death of the owner parent PID alone does not reclaim the lock while an installer child may still run.
- [ ] If ownership disappears without a success record, the operation fails closed. The report includes the exact candidate path, owner and process information, and recovery instructions.
- [ ] A later retry is allowed only after the prior process group is proven gone.
- [ ] Candidate readiness is deterministic from SHA, lockfile digest, and the engine-owned success record. An operator attestation is not required.
- [ ] Candidate setup failure, abandoned ownership, and lock uncertainty enter bounded treatment, Cooling, or an External-condition wait. They do not become generic blocked, needs-human, or terminal mechanical failure. A raw setup or lock failure is not a DecisionRequest or AuthorityRequest.
- [ ] Operator-facing ship and candidate-engine documentation states the candidate-readiness contract. CONTEXT.md keeps the terms `candidate-engine-root`, `candidate-readiness`, and `resolve-and-prepare`. This change does not add a new CLI verb.
- [ ] Regression tests with injected I/O cover fresh roots, every selection source, partial-install retry, setup failure, concurrent wait, abandoned ownership, nested-core selection, post-install dirtiness, and spawn ordering. Unit tests perform no real network, git, or npm calls.
- [ ] `npm run ci` passes.
- [ ] Advance still stops at `pipeline:ready-to-deploy`. Merge stays operator-authorized. This issue does not add `auto_merge` or a merge stage.
