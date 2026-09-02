## Purpose

Defines post-ready release, tag, publication, promotion, deployment, and rollback as RecoverySupervisor-owned exact-candidate operations with Candidate Lineage, durable claims, operation-bound authority, and crash-safe reconciliation.

## ADDED Requirements

### Requirement: RecoverySupervisor SHALL own every post-ready ship phase

RecoverySupervisor SHALL be the sole lifecycle owner for release, tag, finish, publication, promotion, deployment, and rollback. Command, adapter, and ship-status surfaces SHALL report typed operation observations to RecoverySupervisor. Those surfaces SHALL NOT declare terminal lifecycle, choose recovery recipes, or invent a second ship controller. `pipeline ship status` SHALL remain a compatibility projection of that lifecycle.

#### Scenario: Adapter reports observation without declaring terminal

- **WHEN** a release, tag, promote, deploy, or rollback adapter attempt fails, times out, or returns malformed output
- **THEN** the adapter SHALL emit a typed operation observation with side-effect certainty
- **AND** it SHALL NOT mark the Logical Operation complete, cancelled, or human-owned
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Ship status is a projection

- **WHEN** an adapter reads `pipeline ship status --json`
- **THEN** the response SHALL project current RecoverySupervisor lifecycle (phase, candidate, next action, human-authority flag when a typed Authority Request is current)
- **AND** that projection SHALL NOT become scheduler or authority truth

---

### Requirement: Each post-ready ship phase SHALL declare an operation invariant

Each post-ready ship phase SHALL declare its precondition, postcondition, authoritative observer, candidate binding, and replay rule. A process exit, exception, timeout, or model response SHALL be ingress evidence only. Verified completion SHALL require the observer to prove the exact-candidate postcondition.

#### Scenario: Release prepare invariant is explicit

- **WHEN** the release-prepare phase runs
- **THEN** its precondition SHALL include a current FRG-eligible integrated candidate
- **AND** its postcondition SHALL be one release PR whose head is bound to that candidate
- **AND** its observer SHALL be GitHub pull-request identity (repository, number, head SHA, base)
- **AND** a zero exit without that observed identity SHALL NOT complete the phase

#### Scenario: Tag invariant is explicit

- **WHEN** the tag phase runs
- **THEN** its precondition SHALL include a merged release whose merge commit matches the supplied OID
- **AND** its postcondition SHALL be an origin annotated tag on that merge commit
- **AND** a local-only tag SHALL NOT complete the phase

#### Scenario: Deployment invariant is explicit

- **WHEN** the deployment phase runs
- **THEN** its precondition SHALL include a published artifact and authorized promotion target
- **AND** its postcondition SHALL be that authorized artifact digest live in the target environment
- **AND** an installed version string alone SHALL NOT complete the phase

---

### Requirement: Exactness SHALL be represented as Candidate Lineage

Exactness SHALL be represented as Candidate Lineage with this ordered chain: integrated base candidate → FRG candidate → release PR head → release merge result → tag → published artifact → promoted pin → deployed artifact and environment. Each edge SHALL name its own authoritative observer and invalidation rule. A version string SHALL NOT substitute for a lineage node identity.

#### Scenario: Lineage nodes are independently observed

- **WHEN** a ship records progress after release merge
- **THEN** the lineage SHALL retain the integrated candidate, FRG candidate, release PR head, and merge result as distinct identities
- **AND** it SHALL NOT collapse those nodes to one SHA or to the version string

#### Scenario: A later node cannot complete without its prior edge

- **WHEN** publication is requested and the tag node is unproven
- **THEN** the publication phase SHALL NOT complete
- **AND** RecoverySupervisor SHALL keep the tag or publication operation owned until the missing edge is proven or a typed request is current

---

### Requirement: Ship phases SHALL reconcile before and after mutation

Ship phases SHALL re-observe the relevant authoritative system before mutation and after mutation, including after process restart. A completed observation SHALL advance the claim without repeating the mutation. Side-effect certainty of uncertain SHALL require reconciliation before replay. Stable claims SHALL bind operation, repository, lineage node, scope, actor, and expiry.

#### Scenario: Restart after a completed side effect does not replay

- **WHEN** the process dies after a release PR exists, a tag is on origin, a pin is written, or an install completed, and before the next checkpoint
- **THEN** a fresh process SHALL observe that completed side effect
- **AND** it SHALL NOT perform the same mutation twice

#### Scenario: Uncertain side effect is reconciled before replay

- **WHEN** a tag push, pin write, or install times out with unknown completeness
- **THEN** the next attempt SHALL observe the authoritative system first
- **AND** it SHALL replay the mutation only when the postcondition is known absent

---

### Requirement: A failed ship phase SHALL remain owned

A failed, interrupted, or exhausted post-ready ship phase SHALL remain active, cooling, or waiting on an external condition or typed request. Mechanical failure, retry exhaustion, and process death SHALL NOT create an ownerless terminal. Ship SHALL NOT persist a failed phase and rethrow as the product lifecycle outcome.

#### Scenario: Mechanical release failure stays cooling

- **WHEN** release prepare or finish returns a mechanical fault
- **THEN** RecoverySupervisor SHALL keep the operation in Cooling or an external-condition wait
- **AND** `pipeline ship status` SHALL NOT present an ownerless thrown failure as terminal
- **AND** a same-argv retry SHALL resume the same Logical Operation

#### Scenario: Pending external checks stay waiting

- **WHEN** release-PR checks are still pending
- **THEN** the phase SHALL remain an external-condition wait
- **AND** the ship SHALL NOT persist terminal failure solely because that snapshot was pending

---

### Requirement: Ship SHALL NOT infer authority from error-message regex

Ship SHALL NOT set human authority by matching error-message text. Human authority SHALL require a current typed Authority Request or a canonical diagnostic whose projection is `human_authority`. Error prose containing `needs-human`, `missing-authority`, `human authority`, or `specification-decision` SHALL NOT by itself grant or project human authority.

#### Scenario: Error prose does not mint human authority

- **WHEN** a ship phase throws or reports `needs-human: missing-authority for milestone release` without a typed Authority Request or canonical human-authority diagnostic
- **THEN** ship status SHALL NOT set `human_authority` true from that message
- **AND** RecoverySupervisor SHALL treat the observation as mechanical or protocol evidence

#### Scenario: Typed Authority Request still projects human authority

- **WHEN** RecoverySupervisor has a current Authority Request for merge, release, or rollback
- **THEN** ship status MAY project `human_authority` true
- **AND** hosts SHALL NOT re-invoke ship as if the stop were a dead-holder interrupt

---

### Requirement: Operation-bound authority SHALL survive only while its bindings remain valid

Authority SHALL survive safe retry only while operation, repository, candidate, scope, actor, and expiry remain valid. Candidate movement SHALL invalidate stale authorization and verification evidence for that lineage node. Observational event delivery SHALL NOT become lifecycle authority.

#### Scenario: Expired or retargeted authority is refused

- **WHEN** a retry presents authority whose operation, repository, candidate, scope, actor, or expiry no longer matches the current claim
- **THEN** RecoverySupervisor SHALL refuse the protected mutation
- **AND** it SHALL NOT reuse the stale grant

#### Scenario: Candidate movement invalidates verification

- **WHEN** the observed release PR head, pin digest, or deployed digest differs from the authorized lineage node
- **THEN** prior verification evidence SHALL be non-current
- **AND** the phase SHALL NOT complete on the stale evidence

#### Scenario: Deployment pin generation must still hold at mutation

- **WHEN** deployment has bound a pin-generation compare-and-swap claim from the preflight pin
- **AND** another authorized actor retargets that pin before install
- **THEN** deployment SHALL fail without installing
- **AND** it SHALL NOT rewrite the pin to restore the preflight target

#### Scenario: Event notify cannot authorize rollback

- **WHEN** a channel adapter delivers a ship failure event
- **THEN** that delivery SHALL NOT grant rollback or any other protected mutation
- **AND** lifecycle state SHALL remain unchanged by the notify itself

---

### Requirement: Deployment completion SHALL prove the authorized candidate is live

Deployment completion SHALL prove the authorized candidate artifact digest is live in the target environment. A version string, pin file write, or installer exit code SHALL NOT by itself complete deployment.

#### Scenario: Version string is insufficient

- **WHEN** install reports version `X.Y.Z` but the live digest does not match the authorized published artifact
- **THEN** the deployment phase SHALL NOT complete
- **AND** RecoverySupervisor SHALL keep the operation owned

#### Scenario: Matching live digest completes deployment

- **WHEN** the observer proves the authorized artifact digest is the live installed engine in the target host set
- **THEN** the deployment phase MAY complete
- **AND** the lineage deployed node SHALL record that digest and environment

---

### Requirement: Rollback SHALL be a separate protected operation

Rollback SHALL be a distinct supervised operation from deployment. Automatic rollback SHALL require an authenticated envelope that names the exact rollback operation and the retained target. Generic deployment, install, or verify failure SHALL NOT grant rollback authority. Standalone operator `pipeline factory-pin rollback` MAY supply that envelope when the operator invokes it.

#### Scenario: Install failure does not auto-rollback

- **WHEN** promotion or deployment fails after a pin mutation
- **AND** no authenticated rollback envelope names that rollback operation and retained target
- **THEN** RecoverySupervisor SHALL NOT roll the pin back
- **AND** the failed deployment SHALL remain owned (Cooling or wait)
- **AND** the pin and install state SHALL stay available for reconciliation

#### Scenario: Authenticated rollback envelope is required

- **WHEN** an automatic rollback is requested
- **AND** the envelope omits the rollback operation identity or the retained target
- **THEN** rollback SHALL NOT run
- **AND** the deployment failure SHALL remain owned without pin mutation

#### Scenario: Operator rollback remains available

- **WHEN** an operator runs `pipeline factory-pin rollback` with a retained prior pin target
- **THEN** that invocation SHALL be the rollback operation under RecoverySupervisor
- **AND** it SHALL re-observe the retained target before mutation

---

### Requirement: The adapter SHALL interpret one roadmap.release_model policy

The ship adapter SHALL interpret the single `config.roadmap.release_model` policy from `#1024`. When the resolved model is `continuous`, ship SHALL complete when exact-candidate integration into the configured base is proven and SHALL NOT execute SemVer-only FRG, release, tag, publication, promotion, or deployment phases. When the resolved model is `semver` (or the key is absent), ship SHALL execute only the applicable FRG, release, tag, publication, promotion, and deployment phases. The adapter SHALL NOT invent a second `ship.model` key.

#### Scenario: Continuous ship completes at integration

- **WHEN** `roadmap.release_model` is `continuous`
- **AND** the frozen exact candidates are proven integrated into the configured base
- **THEN** ship SHALL complete
- **AND** it SHALL NOT open a release PR, create a tag, publish a GitHub Release, promote a pin, or deploy

#### Scenario: SemVer ship runs applicable post-integration phases

- **WHEN** `roadmap.release_model` is `semver` or the key is absent
- **AND** train merge has proven integration
- **THEN** ship SHALL run FRG, release, tag, publication, promotion, and deployment as applicable
- **AND** it SHALL NOT skip FRG or release-integrity gates to go faster

---

### Requirement: FRG and release-integrity gates SHALL remain enforced

FRG and release-integrity gates SHALL remain enforced on SemVer post-train phases. This capability SHALL NOT default `--skip-frg` on, SHALL NOT treat omitted HMAC as a genuine FRG failure, and SHALL NOT tag, publish, promote, or deploy without the required observer proofs.

#### Scenario: Missing FRG still blocks release finalization

- **WHEN** a SemVer ship reaches release preparation and no release-eligible FRG pass exists
- **THEN** ship SHALL generate or wait for durable FRG evidence
- **AND** it SHALL NOT finish the release PR without a pass

#### Scenario: Skip-frg is not the default

- **WHEN** a SemVer ship runs with no operator `--skip-frg` and no config skip
- **THEN** promotion and deployment SHALL still require FRG evidence
- **AND** a no-frg pin SHALL NOT complete those phases

---

### Requirement: Fresh-process crash tests SHALL cover every external ship-path side effect

Automated checks SHALL cover a fresh-process restart at every external ship-path side-effect boundary: train merge, FRG pack or attestation, release PR create, release merge, tag create or push, GitHub Release publication, production-pin write, host install, and rollback. Each check SHALL prove the completed side effect is not replayed and that an unproven postcondition remains owned. Tests SHALL inject observer and mutation deps. Tests SHALL NOT perform real network, git, or subprocess calls.

#### Scenario: Crash after tag push does not retag

- **WHEN** origin already has the correct annotated tag and a new process resumes the ship
- **THEN** the tag mutation SHALL NOT run again
- **AND** publication wait SHALL continue from that observed tag

#### Scenario: Crash after pin write does not rewrite the pin

- **WHEN** the production pin already names the authorized version and digest
- **AND** a new process resumes promotion
- **THEN** the pin write SHALL NOT run again
- **AND** deployment SHALL reconcile install state next

#### Scenario: Crash with uncertain install stays owned

- **WHEN** install timed out with unknown completeness
- **AND** a new process resumes
- **THEN** the test SHALL observe live install identity before any replay
- **AND** the Logical Operation SHALL remain owned
