# candidate-engine-readiness Specification

## Purpose
Makes every accepted candidate-engine root runnable before any candidate-engine command is spawned, using one shared resolve-and-prepare gate whose proof is SHA plus nested lockfile digest.

## Requirements

### Requirement: Resolve-and-prepare SHALL return a runnable candidate root before spawn

The pipeline SHALL provide one asynchronous resolve-and-prepare seam that selects a candidate-engine root, proves candidate readiness, revalidates exact SHA and tracked cleanliness, and only then returns a root that callers may spawn. After canonicalization, the returned launcher path SHALL be derived from that canonical root. The ship coordinator and hybrid-v2 Layer A collection SHALL call this seam. Tugboat SHALL invoke the same seam before candidate CLI spawn. Leaf candidate invocations SHALL inherit that guarantee and SHALL NOT spawn first to self-heal. The general installed launcher SHALL NOT gain candidate self-healing. Ordinary issue-worktree bootstrap SHALL remain unchanged.

Supported selection sources SHALL be a clean `REPO_DIR` whose HEAD equals the exact candidate SHA, an existing `.worktrees/ship-candidate-<sha>` worktree, `PIPELINE_CANDIDATE_ENGINE_ROOT` after the same HEAD and porcelain checks, and a newly created candidate worktree when creation is allowed. Every supported source SHALL pass the same gate. Identity-only resolution SHALL NOT authorize spawn.

#### Scenario: Fresh candidate worktree is prepared before spawn

- **WHEN** resolve-and-prepare selects a newly created ship-candidate worktree at exact SHA `C`
- **AND** that worktree has no matching readiness record
- **THEN** the seam SHALL prove candidate readiness before it returns the root
- **AND** no candidate-engine command SHALL spawn before that proof succeeds

#### Scenario: Clean REPO_DIR at the candidate SHA is still prepared

- **WHEN** `REPO_DIR` HEAD equals exact SHA `C` and tracked porcelain is empty
- **AND** no matching readiness record exists
- **THEN** the seam SHALL still prove candidate readiness before spawn
- **AND** it SHALL NOT treat HEAD match alone as runnable

#### Scenario: Existing ship-candidate worktree is prepared

- **WHEN** `$REPO_DIR/.worktrees/ship-candidate-<C>` exists with HEAD `C` and empty tracked porcelain
- **AND** no matching readiness record exists
- **THEN** the seam SHALL prove candidate readiness for that worktree before spawn

#### Scenario: PIPELINE_CANDIDATE_ENGINE_ROOT is prepared

- **WHEN** `PIPELINE_CANDIDATE_ENGINE_ROOT` is an absolute directory whose HEAD is exact SHA `C` and tracked porcelain is empty
- **AND** no matching readiness record exists
- **THEN** the seam SHALL prove candidate readiness for that root before spawn

#### Scenario: Spawned launcher is bound to the canonical root

- **WHEN** resolve-and-prepare canonicalizes a lexical candidate root to physical root `R`
- **THEN** the returned launcher path SHALL be `R/scripts/pipeline-launcher.mjs`
- **AND** it SHALL NOT remain the pre-canonical lexical launcher path

#### Scenario: Leaf invocations do not self-heal first

- **WHEN** the ship coordinator or hybrid-v2 Layer A collection has not yet completed resolve-and-prepare
- **THEN** a leaf candidate command SHALL NOT spawn
- **AND** the general installed launcher SHALL NOT install candidate dependencies as a substitute

#### Scenario: Next identical missing-deps fault needs no new mole

- **WHEN** a later consumer selects any accepted source whose candidate `core/` runtime dependencies are missing
- **THEN** that consumer SHALL reuse the same resolve-and-prepare gate
- **AND** the fault SHALL NOT require a new path-local mole issue

---

### Requirement: Candidate readiness SHALL be a SHA-plus-lockfile-digest success record

The pipeline SHALL treat candidate readiness as an engine-owned success record stored outside tracked files, keyed by the candidate SHA and the digest of that SHA's nested `core/package-lock.json`. The record and the setup lock SHALL live in a per-user private runtime or state directory with restrictive permissions. The seam SHALL NOT treat a record or lock as engine-owned when that path is a symbolic link, is group-writable or world-writable, or is owned by a different user id. The seam SHALL NOT follow attacker-controlled entries when reading or writing that state. Shared world-writable `/tmp` SHALL NOT be the trust root. A `core/node_modules` directory alone SHALL NOT count as ready. An unmarked pre-existing or partial install SHALL NOT be trusted. A matching SHA-plus-digest record SHALL skip a new install. Missing, stale, or partial readiness SHALL cause exactly one serialized install in that candidate `core/` from that lockfile. Repository project `setup_command` SHALL NOT skip or replace this readiness. Candidate readiness SHALL be deterministic from SHA, lockfile digest, and the engine-owned success record. An operator attestation SHALL NOT be required.

#### Scenario: Matching record skips reinstall

- **WHEN** a success record exists for candidate SHA `C` and the current nested `core/package-lock.json` digest
- **THEN** resolve-and-prepare SHALL skip a new install
- **AND** it SHALL still revalidate exact SHA and tracked cleanliness before returning the root

#### Scenario: node_modules alone is not ready

- **WHEN** candidate `core/node_modules` exists
- **AND** no matching SHA-plus-digest success record exists
- **THEN** the seam SHALL treat the root as not ready
- **AND** it SHALL run exactly one serialized install from that nested lockfile

#### Scenario: Stale digest reinstalls

- **WHEN** a success record exists for SHA `C` keyed to digest `D1`
- **AND** the nested `core/package-lock.json` digest is now `D2`
- **THEN** the seam SHALL NOT trust that record
- **AND** it SHALL run exactly one serialized install from the current lockfile

#### Scenario: setup_command cannot disable candidate readiness

- **WHEN** repository `.github/pipeline.yml` sets `setup_command` to `""` or to a non-empty override
- **THEN** resolve-and-prepare SHALL still prove candidate readiness
- **AND** it SHALL NOT skip engine bootstrap because of that setting

#### Scenario: Untrusted ready record does not skip install

- **WHEN** a success-record path exists for candidate SHA `C` and the current nested lockfile digest
- **AND** that path is a symbolic link, group-writable or world-writable, or owned by a different user id
- **THEN** the seam SHALL NOT treat that record as matching
- **AND** it SHALL run exactly one serialized install from the current lockfile

#### Scenario: Untrusted setup lock is not ownership

- **WHEN** a setup-lock path exists for the canonical root and SHA `C`
- **AND** that path is a symbolic link, group-writable or world-writable, or owned by a different user id
- **THEN** the seam SHALL NOT wait on that lock as live ownership
- **AND** it SHALL fail closed before spawn
- **AND** it SHALL NOT unlink that untrusted path as reclaim

---

### Requirement: Engine bootstrap SHALL install from the nested candidate core lockfile

Engine bootstrap SHALL select the nested candidate `core/package-lock.json` and SHALL install into that candidate `core/` directory. It SHALL NOT install from a different lockfile. Bootstrap SHALL run only after exact-SHA and tracked-cleanliness validation of an accepted engine source. Extra supply-chain gating or a human security attestation SHALL NOT be required for that nested lockfile install.

#### Scenario: Nested core lockfile is the install input

- **WHEN** missing, stale, or partial readiness triggers install for candidate root `R` at SHA `C`
- **THEN** the install SHALL use `R/core/package-lock.json`
- **AND** the install working directory SHALL be `R/core`
- **AND** the install SHALL NOT use a lockfile from another tree or SHA

#### Scenario: Missing nested lockfile fails closed

- **WHEN** the accepted candidate root at SHA `C` has no nested `core/package-lock.json`
- **THEN** resolve-and-prepare SHALL fail closed before spawn
- **AND** it SHALL write no success record

---

### Requirement: Concurrent consumers SHALL share one child-safe serialized install

The pipeline SHALL serialize candidate setup by canonical candidate root and SHA. Canonical root SHALL be the symlink-resolved checkout path. Concurrent consumers of that pair SHALL perform one install. Waiters SHALL reuse that result and SHALL observe bounded heartbeats from the live installer. Locks and readiness records SHALL NOT be stored inside the tracked candidate worktree. They SHALL live in a per-user private runtime or state directory and SHALL NOT use shared world-writable `/tmp` as the trust root. Ownership SHALL be child-safe: death of the owner parent PID alone SHALL NOT reclaim the lock while an installer child may still run. Missing installer child identity after owner death SHALL be unresolved ownership and SHALL NOT reclaim. The engine SHALL NOT automatically reclaim a setup lock when the owner parent PID is dead.

#### Scenario: Two waiters share one install

- **WHEN** two consumers request resolve-and-prepare for the same canonical root and SHA `C` with no matching readiness record
- **THEN** exactly one install SHALL run
- **AND** the waiter SHALL reuse that result
- **AND** the waiter SHALL observe bounded heartbeats from the live installer

#### Scenario: Two aliases of one checkout share one install

- **WHEN** two consumers request resolve-and-prepare for the same physical candidate checkout at SHA `C` through different lexical paths
- **AND** no matching readiness record exists
- **THEN** exactly one install SHALL run
- **AND** lock and readiness identity SHALL use the canonical root

#### Scenario: Parent death does not reclaim a live installer

- **WHEN** the owner parent PID is dead
- **AND** an installer child process group may still run
- **THEN** the engine SHALL NOT reclaim the setup lock
- **AND** waiters SHALL continue to treat the install as owned until the child-safe contract allows a closed outcome

#### Scenario: Missing child identity after owner death does not reclaim

- **WHEN** the owner parent PID is dead
- **AND** the setup lock has no installer child process-group identity
- **THEN** the engine SHALL NOT reclaim the setup lock
- **AND** the operation SHALL fail closed
- **AND** a later retry SHALL be refused until the prior process group is proven gone

---

### Requirement: Setup and lock failure SHALL fail closed with candidate-local remediation

Setup failure SHALL prevent candidate spawn, SHALL write no success record, SHALL name the exact candidate path, and SHALL instruct candidate-local remediation in that candidate `core/`. It SHALL NOT recommend a global package reinstall. When the lock is the cause, the report SHALL also name owner and process information. If ownership disappears without a success record, the operation SHALL fail closed with the exact candidate path, owner and process information, and recovery instructions. A later retry SHALL be allowed only after the prior process group is proven gone.

#### Scenario: Install failure names the candidate core path

- **WHEN** the nested-core install exits non-zero
- **THEN** resolve-and-prepare SHALL fail closed before any candidate-engine command spawn
- **AND** it SHALL write no success record
- **AND** the report SHALL name the exact candidate path
- **AND** the report SHALL instruct remediation in that candidate `core/`
- **AND** the report SHALL NOT recommend a global package reinstall

#### Scenario: Abandoned ownership fails closed

- **WHEN** setup ownership disappears without a success record
- **THEN** the operation SHALL fail closed
- **AND** the report SHALL include the exact candidate path
- **AND** the report SHALL include owner and process information
- **AND** the report SHALL include recovery instructions
- **AND** a later retry SHALL be refused until the prior process group is proven gone

#### Scenario: Retry after the prior process group is gone

- **WHEN** a prior setup failed closed because ownership disappeared
- **AND** the prior process group is proven gone
- **THEN** a later resolve-and-prepare SHALL be allowed to acquire setup and retry

---

### Requirement: Exact SHA and tracked cleanliness SHALL be revalidated after bootstrap

The seam SHALL validate exact SHA and tracked cleanliness before bootstrap and again after bootstrap. The pre-bootstrap validation SHALL run on the canonical candidate root immediately before lockfile digest and install ownership authorize bootstrap. A mismatch SHALL fail closed before spawning the nested-core install. Bootstrap SHALL NOT weaken exact-SHA or clean-worktree checks. Locks and readiness records SHALL remain outside the tracked candidate worktree so those checks stay meaningful.

#### Scenario: Mutation between resolve and bootstrap fails closed before install

- **WHEN** identity resolution accepted a candidate root at SHA `C` with empty tracked porcelain
- **AND** HEAD or tracked porcelain at the canonical root changes before bootstrap
- **THEN** resolve-and-prepare SHALL fail closed before spawning the nested-core install
- **AND** it SHALL write no success record

#### Scenario: Post-bootstrap dirty tree fails closed

- **WHEN** bootstrap completes
- **AND** tracked porcelain at the candidate root is no longer empty
- **THEN** resolve-and-prepare SHALL fail closed
- **AND** it SHALL NOT return a spawnable root
- **AND** it SHALL write no success record

#### Scenario: Post-bootstrap SHA mismatch fails closed

- **WHEN** bootstrap completes
- **AND** candidate HEAD is no longer the exact requested SHA
- **THEN** resolve-and-prepare SHALL fail closed
- **AND** it SHALL NOT return a spawnable root
- **AND** it SHALL write no success record

---

### Requirement: Candidate setup and lock failures SHALL remain supervised lifecycle states

Candidate setup failure, abandoned ownership, and lock uncertainty SHALL remain supervised lifecycle states. They SHALL enter bounded treatment, Cooling, or an External-condition wait. They SHALL NOT become generic blocked, needs-human, or terminal mechanical failure. A raw setup or lock failure SHALL NOT be a DecisionRequest or AuthorityRequest. Only a current unavailable external capability MAY produce a typed CapabilityRequest. This requirement SHALL NOT add a new recover recipe.

#### Scenario: Missing candidate dependencies are not needs-human

- **WHEN** resolve-and-prepare fails because candidate runtime dependencies are missing or install failed
- **THEN** the outcome SHALL be a supervised lifecycle state (bounded treatment, Cooling, or External-condition wait)
- **AND** it SHALL NOT be recorded as generic blocked, needs-human, or terminal mechanical failure
- **AND** it SHALL NOT create a DecisionRequest or AuthorityRequest solely for that setup failure

#### Scenario: Abandoned lock is not an AuthorityRequest

- **WHEN** ownership disappears without a success record
- **THEN** the outcome SHALL fail closed as a supervised lifecycle state
- **AND** it SHALL NOT create an AuthorityRequest solely for lock uncertainty

---

### Requirement: Operator-facing documentation SHALL state the candidate-readiness contract

Operator-facing ship and candidate-engine documentation SHALL state that every accepted root is made runnable before spawn, that readiness is SHA plus lockfile digest, and that fail-closed recovery is candidate-local. CONTEXT.md SHALL keep the terms `candidate-engine-root`, `candidate-readiness`, and `resolve-and-prepare`. This change SHALL NOT add a new CLI verb. A plugin SKILL rewrite SHALL NOT be the product change.

#### Scenario: Ship runbook states spawn-after-ready

- **WHEN** an operator reads the ship-milestone runbook and candidate-engine notes
- **THEN** those docs SHALL state that every accepted candidate root is made runnable before spawn
- **AND** they SHALL state that readiness is SHA plus nested lockfile digest
- **AND** they SHALL state that fail-closed recovery is candidate-local

#### Scenario: No new CLI verb

- **WHEN** this change is implemented
- **THEN** the pipeline CLI verb table SHALL NOT gain a new verb for candidate setup
- **AND** CONTEXT.md SHALL still define `candidate-engine-root`, `candidate-readiness`, and `resolve-and-prepare`

---

### Requirement: Injected-I/O tests SHALL prove spawn-after-ready

Unit tests with injected I/O SHALL cover fresh roots; every selection source (clean `REPO_DIR`, existing ship-candidate worktree, `PIPELINE_CANDIDATE_ENGINE_ROOT`, newly created worktree); partial or unmarked install retry; setup failure with no success record and no spawn; concurrent waiters sharing one install; two lexical aliases of one checkout sharing one install; spawned launcher bound to the canonical root after symlink retarget; mutation between identity resolution and bootstrap fail-closed before install; pre-existing untrusted ready-record and setup-lock paths; abandoned ownership fail-closed; owner death before child-PGID publication fail-closed without reclaim; nested-core lockfile selection; post-bootstrap SHA or tracked-dirty mismatch fail-closed; and spawn ordering (no candidate command before readiness success). Unit tests SHALL perform no real network, git, or npm calls. `npm run ci` SHALL pass.

#### Scenario: Spawn ordering test fails if a command precedes readiness

- **WHEN** a unit test records candidate-command spawn against an injected installer
- **AND** readiness has not yet succeeded
- **THEN** that test SHALL fail

#### Scenario: Unit tests inject I/O

- **WHEN** the candidate-readiness unit suite runs
- **THEN** it SHALL inject filesystem, process, lock, digest, canonicalize, and install seams
- **AND** it SHALL NOT perform real network, git, or npm calls

### Requirement: Every candidate-engine operation SHALL cross the shared resolve-and-prepare gate

Every production route that executes candidate-engine code SHALL obtain its launcher and canonical root from the shared resolve-and-prepare gate. Before returning, that gate SHALL prove the requested exact candidate SHA, approved root, candidate readiness, and tracked cleanliness both before and after any bootstrap. An identity-only resolver, prior readiness for another SHA or lockfile digest, path-local bootstrap, or inherited process launcher SHALL NOT authorize candidate-engine execution. The executable operation inventory SHALL cover every candidate-engine consumer and the repository hard gate SHALL fail when a consumer bypasses resolve-and-prepare.

#### Scenario: Inventory consumer cannot spawn before preparation

- **WHEN** an inventoried ship, Factory Reliability Gate, release, recovery, or host-adapter route requests candidate-engine execution
- **AND** resolve-and-prepare has not returned a proof for the exact requested candidate
- **THEN** no candidate-engine process SHALL spawn
- **AND** the route SHALL fail closed with typed diagnostics

#### Scenario: Candidate movement invalidates prepared identity

- **WHEN** a root was prepared at candidate SHA `C1`
- **AND** its HEAD moves to `C2` before the candidate command starts
- **THEN** the candidate command SHALL NOT spawn on the prior proof
- **AND** resolve-and-prepare SHALL require exact identity, readiness, and cleanliness proof for `C2`

#### Scenario: New candidate consumer without the gate fails validation

- **WHEN** a production route capable of spawning candidate-engine code is added without an exercised resolve-and-prepare binding
- **THEN** the repository hard validation gate SHALL fail
- **AND** the failure SHALL identify that consumer

#### Scenario: Aliased candidate process start fails validation

- **WHEN** a production route starts a candidate-engine process through an aliased spawn or exec callee of the launcher path
- **AND** that start is not the registered resolve-and-prepare process boundary
- **THEN** the repository hard validation gate SHALL fail
- **AND** the failure SHALL identify that consumer

#### Scenario: Detached pack loop retains candidate-root exclusion until child exit

- **WHEN** a pack-loop consumer hands off a detached candidate supervisor
- **THEN** the candidate-root process lease SHALL remain held by that supervisor
- **AND** a later start on the same canonical root SHALL fail closed while the supervisor is live
- **AND** a dead supervisor SHALL be reclaimable
- **AND** distinct candidate SHAs sharing one canonical root SHALL contend on that same lease
