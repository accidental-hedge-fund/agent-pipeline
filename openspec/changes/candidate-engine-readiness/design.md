## Context

See `proposal.md` for motivation. Today `resolveCandidateEngine` in `core/scripts/ship-end-candidate.ts` selects an exact-SHA clean root from four sources and returns it. Production defaults in `core/scripts/stages/ship-adapter.ts` (`realShipCoordinatorDeps`) and `core/scripts/frg-hybrid-v2-from-run.ts` (`defaultResolveCandidateEngineForCollect`) already inject that helper asynchronously. Tugboat duplicates identity selection in `resolve_ship_end_cli` and then spawns `SHIP_END_CLI`. None of those paths prove the candidate engine can load TypeScript from nested `core/`.

Ordinary issue-worktree setup (`detectAndInstall` in `core/scripts/worktree-setup.ts`) can skip on empty `setup_command` and treats `node_modules` presence as ready. `PipelineLock` reclaims on parent-PID death. Both contracts contradict this issue.

### Engine-dogfood bar (#1344)

1. **Class vs site.** Class: an accepted candidate-engine root may be spawned before engine runtime readiness is proven. Site: `pipeline ship --milestone v1.40.0` FRG against candidate `385bf89f3cfb220e2e3a40abc333496fb3fca091` with missing candidate `core/node_modules`.
2. **Shared law.** One resolve-and-prepare gate on the existing candidate controller. Validate SHA and cleanliness, bootstrap from that SHA's nested `core/package-lock.json`, revalidate, then allow spawn. Child-safe serialization. Candidate-local fail-closed text. Not a new recover recipe. Not a ship-FRG-only install.
3. **Next identical fault.** Missing candidate runtime dependencies at spawn is a gate miss. New sources and new consumers reuse the same gate.

## Goals / Non-Goals

**Goals:**

- Wrap the existing resolver with one asynchronous prepare step that both named consumers call.
- Prove readiness with an external SHA-plus-lockfile-digest record, not `node_modules`.
- Serialize one nested-core `npm ci` per canonical root and SHA with child-safe ownership.
- Keep exact-SHA and clean-worktree checks meaningful by storing lock and record outside the tracked tree.

**Non-Goals:**

- Changing `detectAndInstall` or ordinary issue-worktree bootstrap.
- Moving bootstrap into `scripts/pipeline-launcher.mjs` or host SKILL shims.
- Auto-reclaim of a setup lock when the owner parent PID is dead.
- A new `pipeline` verb, extra supply-chain gating, or operator attestation.
- `auto_merge`, a merge stage, or a special ship of the readiness gate.

## Decisions

### 1. First holding rung: wrap `resolveCandidateEngine`, do not invent a controller

**Choice:** Keep `resolveCandidateEngine` as the SHA and cleanliness selector. Add one asynchronous resolve-and-prepare function in the same module (or a sibling helper that that module exports). Point the existing ship-coordinator and hybrid-v2 injectables at it. Tugboat invokes that same TypeScript seam from the runnable pin process (Node on pin `core/`) before `SHIP_END_CLI` spawn.

**Why:** The source allowlist, porcelain checks, and injectable deps already exist. Both TypeScript consumers already accept `Promise<CandidateEngineResult>`. A second source list or a new controller file would be a custom layer.

**Alternatives considered:**

- Call `detectAndInstall` on the candidate root → rejected: empty `setup_command` skips; `node_modules` is treated as ready; root lockfile would win over nested `core/` in other repos.
- Ship-FRG-only `npm ci` in `ship-adapter.ts` → rejected: Layer A collect stays broken; next consumer is a new mole.
- Self-heal inside `pipeline-launcher.mjs` → rejected: general launcher must not gain candidate self-healing; leaves would spawn first.
- New `pipeline` verb for prepare → rejected: issue forbids a new verb.

### 2. Nested `core/package-lock.json` is the only install input

**Choice:** After SHA and cleanliness pass, digest `core/package-lock.json` under the accepted root. Install with `npm ci` and CWD `<root>/core`. Do not consult repository `setup_command`. Do not select a root lockfile or another tree's lockfile.

**Why:** The product engine lives in nested `core/`. This repository has no root `package-lock.json`. Worktree-setup's generic detector is the wrong contract.

**Alternatives considered:**

- Reuse `choosePackageRoot` from worktree-setup → rejected: root lockfile wins; multiple first-level lockfiles skip; `setup_command` overrides.
- Install from pin `core/package-lock.json` into the candidate → rejected: different lockfile than the SHA being run.

### 3. Readiness record and lock live outside the tracked tree

**Choice:** Store the success record and the setup lock in host-local untracked state keyed by canonical root (resolved absolute path) plus candidate SHA plus lockfile digest. Sibling files under `/tmp` (same family as `PipelineLock` paths) are sufficient. Do not write lock or ready files inside the candidate worktree.

**Why:** Porcelain must stay empty for the post-bootstrap revalidation. A matching record skips reinstall. Missing, stale digest, or partial (no record) triggers one serialized install.

**Alternatives considered:**

- Infer ready from `core/node_modules` → rejected: unmarked or partial install is the defect.
- Write `.pipeline-candidate-ready` inside the worktree → rejected: dirties porcelain or requires ignore games.
- Put records under `.agent-pipeline/` in `REPO_DIR` → optional later; `/tmp` matches existing host-local locks and does not expand the artifact-ignore contract in this change.

### 4. Child-safe ownership reuses marker identity, not `PipelineLock` reclaim

**Choice:** Acquire with atomic create (`O_CREAT|O_EXCL`). Record parent PID, parent starttime (`formatProcessIdentityMarker`), installer child process-group id, and child starttime. Installer writes a bounded heartbeat. Waiters share one install while the child group is alive or the heartbeat is fresh. Parent-PID death alone does not unlink the lock. If ownership disappears without a success record, fail closed with path, owner, and process data. Retry only after the prior process group is proven gone.

**Why:** `PipelineLock.handleExistingLock` treats parent `ESRCH` as stale and reclaims. That is unsafe while `npm ci` may still run in a detached process group (`worktree-setup` already uses `detached: true`).

**Reuse:** Atomic create, pid+starttime markers, and `/tmp` path construction. Not reclaim-on-dead-PID.

**Alternatives considered:**

- Reuse `PipelineLock` as-is → rejected: auto-reclaim on dead parent.
- Auto-reclaim when parent is dead and heartbeat is stale, without proving the child group is gone → rejected: issue forbids automatic reclaim on parent death.

### 5. Tugboat calls the TypeScript seam from the pin process

**Choice:** After train-complete, Tugboat invokes pin-side Node on the candidate-engine module's resolve-and-prepare export (not a new CLI verb) and binds `SHIP_END_CLI` to the returned root. Shell `resolve_ship_end_cli` must not remain an identity-only spawn path. Tugboat must not `npm ci` in bash.

**Why:** Process-start Tugboat / pin CLI is already runnable. The candidate is the one that may lack `core/node_modules`. One seam, two composers.

**Alternatives considered:**

- Keep shell identity, add `npm ci` in `tugboat.sh` → rejected: second bootstrap path; `setup_command` and digest proof would drift.
- Re-exec candidate `tugboat.sh` first and let the launcher install → rejected: launcher must not self-heal.

### 6. Supervised lifecycle, not a new recover recipe

**Choice:** Map setup failure, abandoned ownership, and lock uncertainty onto existing supervised outcomes (bounded treatment, Cooling, External-condition wait). Do not add a recipe to `blocked-recovery-recipes`. Do not emit DecisionRequest or AuthorityRequest. CapabilityRequest only when an external capability is currently unavailable.

**Why:** This is a gate miss, not human product judgment and not missing merge authority.

## Risks / Trade-offs

- **[Risk] `/tmp` readiness records vanish on reboot** → Mitigation: missing record retriggers one serialized install. Deterministic and acceptable.
- **[Risk] `npm ci` mutates candidate `node_modules` while SHA checks run** → Mitigation: validate clean before install; revalidate SHA and tracked porcelain after; ignore untracked `node_modules`.
- **[Risk] Tugboat pin-side Node invoke fails on a host without pin `core/node_modules`** → Mitigation: pin is the promoted engine and is already required to run train. Fail closed with candidate-local text, not a global reinstall instruction.
- **[Risk] Concurrent waiters block too long** → Mitigation: bounded heartbeats; stale heartbeat plus proven-dead process group fails closed rather than waiting forever.
- **[Risk] Implementer reuses `detectAndInstall` or `PipelineLock` reclaim** → Mitigation: tasks and this design name those as non-reuse. Tests must fail if `setup_command: ""` skips candidate bootstrap or if parent death reclaims a live child.

## Migration Plan

- Land the seam and caller wiring in one change. No staged flag.
- Existing candidate worktrees without a success record get one install on next ship or Layer A collect.
- Rollback: revert the change. Identity-only resolution returns. Missing `node_modules` fails at first candidate command again.

## Open Questions

None. Grill decisions settle proof, lock reclaim, shared seam, failure text, docs, and merge authority.
