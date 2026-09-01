## 1. Injected-I/O tests that fail without the gate

- [x] 1.1 Add a candidate-readiness unit suite (injected fs, digest, install, lock, porcelain, HEAD) that records spawn vs prepare order and fails if any candidate command is recorded before readiness success. Verify the test fails on current identity-only `resolveCandidateEngine`.
- [x] 1.2 Cover every selection source with the same injected suite: clean `REPO_DIR`, existing `.worktrees/ship-candidate-<sha>`, `PIPELINE_CANDIDATE_ENGINE_ROOT`, and newly created worktree. Verify each source asserts prepare ran and spawn did not precede it.
- [x] 1.3 Add cases for unmarked `core/node_modules` (no success record), stale lockfile digest, and partial install. Verify each triggers exactly one injected nested-core install and writes no success record until that install succeeds.
- [x] 1.4 Add setup-failure, concurrent-waiter, abandoned-ownership, nested-core lockfile selection, and post-bootstrap SHA or tracked-dirty mismatch cases. Verify: no success record and no spawn on failure; one shared install plus waiter heartbeats on concurrency; fail-closed without reclaim when parent PID is dead and child group may still live; install CWD is candidate `core/` from that SHA's `core/package-lock.json`. Confirm unit tests make no real network, git, or npm calls.

## 2. Resolve-and-prepare seam

- [x] 2.1 Export one asynchronous resolve-and-prepare wrapper beside existing `resolveCandidateEngine` in `core/scripts/ship-end-candidate.ts` (same source allowlist and porcelain/HEAD deps). Verify 1.1–1.2 fail until this wrapper validates SHA and cleanliness, prepares, revalidates, and only then returns a spawnable root.
- [x] 2.2 Keep identity-only `resolveCandidateEngine` as the selector used by the wrapper. Verify no second source list exists and abbreviated SHA, dirty tree, and relative `PIPELINE_CANDIDATE_ENGINE_ROOT` still fail closed as today.
- [x] 2.3 Do not call `detectAndInstall` and do not honor `setup_command`. Verify a fixture with `setup_command: ""` still prepares the candidate and that the test fails if that setting skips bootstrap.

## 3. Readiness record and nested-core install

- [x] 3.1 Store the success record outside tracked files, keyed by canonical root, candidate SHA, and nested `core/package-lock.json` digest. Verify a matching record skips the injected install and a digest mismatch retriggers one install.
- [x] 3.2 On missing, stale, or partial readiness, spawn injected `npm ci` with CWD `<root>/core` using that SHA's nested lockfile. Verify the test fails if install CWD is the worktree root or a different lockfile is used.
- [x] 3.3 Write the success record only after install success and after post-bootstrap SHA plus tracked-clean revalidation. Verify 1.4 dirty/SHA-mismatch cases write no record and return no spawnable root.
- [x] 3.4 On install failure, return a closed error that names the exact candidate path and instructs candidate-local remediation in that `core/`. Verify the message does not recommend a global package reinstall.

## 4. Child-safe setup lock

- [x] 4.1 Serialize setup by canonical root and SHA with atomic create, pid+starttime parent identity, installer child PGID, and bounded heartbeats. Store the lock outside the tracked candidate worktree. Verify two concurrent injected callers perform one install and the waiter observes heartbeats.
- [x] 4.2 Do not reclaim on owner parent PID death. Verify the abandoned-ownership test fails closed with candidate path plus owner/process data when the lock vanishes without a success record, and that parent `ESRCH` with a possibly live child does not unlink the lock.
- [x] 4.3 Allow retry only after the prior process group is proven gone. Verify a follow-up injected call is refused while that group remains and is allowed once it is gone.

## 5. Caller wiring

- [x] 5.1 Point `realShipCoordinatorDeps` at resolve-and-prepare. Verify the ship-adapter spawn test records no leaf `factory-release` / `factory-gate` / `release` argv until the seam returns a ready root, and that a prepare failure persists train evidence and does not spawn.
- [x] 5.2 Point hybrid-v2 `defaultCollectHybridV2FromRun` at the same seam. Verify Layer A collect fails closed before TAP when readiness fails and does not hash pin-source TAP as packed candidate `C`.
- [x] 5.3 Invoke the same TypeScript seam from Tugboat after train-complete (pin-side Node, no new CLI verb) before `SHIP_END_CLI` spawn. Verify Tugboat tests fail if `resolve_ship_end_cli` still spawns candidate CLI after identity-only resolution, and that Tugboat does not `npm ci` in bash.
- [x] 5.4 Leave `scripts/pipeline-launcher.mjs` and host SKILL shims without candidate self-healing. Verify a source assertion fails if the launcher grows an install-on-missing-`node_modules` path.

## 6. Lifecycle and docs

- [x] 6.1 Classify candidate setup failure, abandoned ownership, and lock uncertainty as supervised lifecycle (bounded treatment, Cooling, or External-condition wait). Verify ship status/tests do not record generic blocked, needs-human, DecisionRequest, or AuthorityRequest for a raw setup or lock failure, and that no new recover recipe is added.
- [x] 6.2 Update `docs/runbooks/ship-milestone.md` and supervisor candidate-engine notes: every accepted root is made runnable before spawn; readiness is SHA plus nested lockfile digest; fail-closed recovery is candidate-local. Verify CONTEXT.md still defines `candidate-engine-root`, `candidate-readiness`, and `resolve-and-prepare`.
- [x] 6.3 Do not add a CLI verb. After any `core/` edit run `node scripts/build.mjs`. Verify `openspec validate candidate-engine-readiness` and `npm run ci` pass.
