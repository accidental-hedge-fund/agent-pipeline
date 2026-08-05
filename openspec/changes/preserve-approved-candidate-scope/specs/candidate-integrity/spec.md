## ADDED Requirements

### Requirement: Candidate-integrity manifest SHALL snapshot approved candidate surface before pipeline-owned mutations

The engine SHALL define a versioned `CandidateIntegrityManifest` (`schema_version`
integer starting at `1`) that records, at capture time:

- run and subject identity (`run_id`, issue, PR when known, domain when known)
- authoritative `base_ref` and full 40-character `base_sha`
- full 40-character `candidate_sha` of the PR head being snapshotted
- the deterministic changed-path surface of the candidate versus that base
- sufficient deterministic path/content digests (or equivalent tree digest over
  path→content-hash pairs) to detect path adds, removes, and content changes
- optional bounded enrichments (diff size metrics, path-class tags, declared
  repair scope) that MUST NOT be the sole safety boundary
- producer identity of the deterministic module that built the manifest

Before every pipeline-owned candidate-moving operation in the covered method set
(`restack`, `rebase`, `conflict_repair`, `pre_merge_autofix`, `recovery_repair`),
the engine SHALL capture and durable-persist a pre-mutation manifest for that
subject. Capture SHALL use the authoritative base and PR head available at that
moment, not a stale worktree-only guess when authoritative remotes/refs are
readable.

#### Scenario: Pre-mutation manifest is persisted before restack

- **WHEN** the pipeline is about to perform a covered restack that will move the
  PR head
- **THEN** it SHALL persist a `CandidateIntegrityManifest` with `schema_version`
  ≥ 1 for the current candidate SHA and base SHA
- **AND** the manifest SHALL include the changed-path surface and path/content
  digests needed for later comparison
- **AND** the mutation SHALL NOT begin until that pre-manifest is durable

#### Scenario: Pre-mutation capture covers auto-fix and recovery repair

- **WHEN** the pipeline is about to run pre-merge auto-fix or recovery
  `repair_pipeline_item` that may change the candidate head
- **THEN** it SHALL capture and persist a pre-mutation manifest under the same
  schema as restack/rebase
- **AND** the `mutation_method` recorded for the subsequent transition SHALL
  identify the method (`pre_merge_autofix` or `recovery_repair`)

#### Scenario: Manifest fields are deterministic and provider-neutral

- **WHEN** a manifest is serialized
- **THEN** it SHALL NOT depend on provider-specific model self-attestation
- **AND** digests and path listings SHALL be reproducible from the same tree
  inputs under injected deps in unit tests

---

### Requirement: Post-mutation comparison SHALL classify the candidate transition

The engine SHALL re-read the authoritative PR head and base, build a post-mutation `CandidateIntegrityManifest`, compare it to the pre-mutation manifest, and classify the transition after a covered candidate-moving operation completes (success path that yields a new or same published head). Classification SHALL be exactly one of:

- `semantically_equivalent` — same path set and same per-path content digests
  versus base as the pre-manifest (commit identity may change)
- `expected_scoped_change` — non-empty surface delta entirely within the
  declared repair scope for that mutation
- `scope_expansion` — undeclared path add/remove or content change outside
  declared scope, or equivalent undeclared surface growth
- `unverified` — missing pre-manifest, unreadable authoritative head/base,
  incomplete digests, or comparison failure

Classification SHALL use path and content evidence plus declared repair scope.
Raw diff size MAY enrich diagnostics and events but MUST NOT be the sole
criterion that accepts or rejects a transition.

#### Scenario: Clean rebase preserves surface and is not scope expansion

- **WHEN** a rebase or restack changes candidate commit identity
- **AND** the post-manifest path set and per-path content digests versus base
  match the pre-manifest
- **THEN** classification SHALL be `semantically_equivalent`
- **AND** the engine SHALL NOT emit a `scope_expansion` finding for that
  transition solely because the SHA changed

#### Scenario: Undeclared path append is scope expansion

- **WHEN** post-mutation comparison finds a path that was not in the
  pre-manifest changed surface and is not covered by declared repair scope
- **OR** a previously present path's content digest changes without being in
  declared scope
- **THEN** classification SHALL be `scope_expansion`

#### Scenario: Intended auto-fix within declared scope is expected scoped change

- **WHEN** pre-merge auto-fix declares a repair scope covering path `P`
- **AND** the only post-mutation content changes versus the pre-manifest are
  within that declared scope
- **THEN** classification SHALL be `expected_scoped_change`
- **AND** SHALL NOT be `semantically_equivalent`

#### Scenario: Incomplete comparison fails closed as unverified

- **WHEN** the pre-manifest is missing, the authoritative head or base cannot be
  re-read, or digests cannot be completed
- **THEN** classification SHALL be `unverified`
- **AND** the engine SHALL NOT treat the transition as `semantically_equivalent`

#### Scenario: Diff size alone does not reject a large in-scope change

- **WHEN** a mutation produces a large line or byte delta
- **AND** all path/content changes lie within declared repair scope
- **AND** digests are complete
- **THEN** classification SHALL be `expected_scoped_change` (or
  `semantically_equivalent` if digests match pre)
- **AND** SHALL NOT be `scope_expansion` solely because the raw size is large

---

### Requirement: Scope expansion and unverified comparison SHALL invalidate review and readiness evidence

When classification is `scope_expansion` or `unverified`, the engine SHALL
invalidate prior review evidence and readiness evidence for the pre-mutation
candidate as authority for the post-mutation head. The engine SHALL emit a
structured candidate-integrity diagnostic naming the classification,
before/after candidate SHAs, mutation method, and invalidation reason. The
engine SHALL route the item to scoped review or bounded engine recovery as
appropriate for the stage. The engine MUST NOT silently advance the item to
`pipeline:ready-to-deploy` on that head, and MUST NOT create a human-authority
hold solely because of this mechanical integrity classification.

#### Scenario: Scope expansion blocks ready-to-deploy without human hold

- **WHEN** a covered mutation classifies as `scope_expansion`
- **THEN** prior approve verdicts and readiness claims bound to the pre-mutation
  surface SHALL NOT authorize ready-to-deploy for the post-mutation head
- **AND** a structured diagnostic SHALL be emitted with classification
  `scope_expansion`
- **AND** the item SHALL be routed to scoped review or bounded recovery
- **AND** the disposition SHALL NOT be recorded as a human-authority hold solely
  for this integrity class

#### Scenario: Unverified comparison fails closed the same way

- **WHEN** classification is `unverified`
- **THEN** the engine SHALL invalidate readiness for the unconfirmed transition
- **AND** SHALL NOT treat prior review as sufficient for the new head
- **AND** SHALL NOT silently reach ready-to-deploy

#### Scenario: Expected scoped change forces re-review at the new SHA

- **WHEN** classification is `expected_scoped_change` and the candidate SHA
  changed
- **THEN** the engine SHALL require fresh review (or the existing delta-review
  path) against the new candidate SHA before readiness
- **AND** SHALL NOT carry forward ready-to-deploy from the pre-mutation SHA

---

### Requirement: Semantically equivalent restack SHALL re-evaluate current-head gates

The engine SHALL re-evaluate all current-head gates required for readiness against the post-mutation authoritative candidate SHA when classification is `semantically_equivalent`, and SHALL NOT treat that transition as scope expansion solely because the SHA changed. Re-evaluated gates SHALL include review-SHA / blocking-key rules, CI, Tester evidence pin when present, and deterministic repository invariants. Semantic equivalence alone SHALL NOT skip those gates.

#### Scenario: Clean restack re-gates without false expansion

- **WHEN** a restack classifies as `semantically_equivalent`
- **THEN** the engine SHALL re-evaluate current-head readiness gates for the
  new candidate SHA
- **AND** SHALL NOT emit a scope-expansion invalidation for that transition
- **AND** SHALL NOT mark ready-to-deploy until those gates pass on the current
  head

---

### Requirement: Manifests SHALL hydrate across restart and reattach

A restart, reattach, or new process resuming the same run SHALL hydrate the
durable pre-mutation and last post-mutation manifests (when present) rather
than silently resetting them. If a mutation was claimed or the head advanced
without a completed post-classification, the engine SHALL treat the transition
as requiring re-classification and MUST NOT reuse pre-mutation review evidence
as readiness authority for the post-mutation head until classification and
current-head gates succeed.

#### Scenario: Restart preserves pre-manifest

- **WHEN** a pre-mutation manifest was persisted and the process restarts before
  post-classification completes
- **THEN** the resumed run SHALL load the same pre-manifest identity and
  digests
- **AND** SHALL NOT rebuild the pre-manifest from the post-mutation head as if
  it were the approved surface

#### Scenario: Restart refuses stale review for readiness

- **WHEN** after restart the candidate SHA differs from the SHA of the last
  approved review
- **AND** integrity classification for the intervening mutation is missing or
  `unverified` / `scope_expansion`
- **THEN** the engine SHALL NOT mark ready-to-deploy using the stale review
  evidence alone

---

### Requirement: Durable candidate_integrity events SHALL record the transition

The engine SHALL append durable run-ledger events with `type` equal to
`candidate_integrity` (exact string) for covered transitions. Each event SHALL
include, when known:

- before and after candidate SHAs
- mutation method
- classification
- bounded changed-path summary
- review and/or readiness invalidation reason or flags when invalidation occurs
- optional path class and engine version fields consumable by scoreboard
  observability

Missing optional enrichments SHALL NOT prevent emission of the required core
fields.

#### Scenario: Scope expansion event carries invalidation fields

- **WHEN** a transition classifies as `scope_expansion` and invalidates review
- **THEN** a `candidate_integrity` event SHALL be appended
- **AND** it SHALL include before/after SHAs, mutation method, classification
  indicating scope expansion, and an invalidation reason or
  `invalidated_review` signal

#### Scenario: Clean restack event is still emitted

- **WHEN** a transition classifies as `semantically_equivalent`
- **THEN** a `candidate_integrity` event SHALL still be emitted with that
  classification and mutation method
- **AND** it SHALL NOT claim scope-expansion invalidation

---

### Requirement: Ready-to-deploy SHALL require current-SHA-bound evidence

The engine SHALL NOT transition an issue to `pipeline:ready-to-deploy` unless
review evidence, CI (when required by existing gates), and deterministic
repository invariants all apply to the **current** authoritative candidate SHA
after any covered mutation and its integrity classification. When SHA-pinned
Tester evidence (#646) is available, readiness SHALL respect its staleness
rules for the current candidate SHA. Candidate-integrity success alone SHALL
NOT replace review or CI.

#### Scenario: Stale review after mutation cannot authorize ready-to-deploy

- **WHEN** the current candidate SHA is not covered by current review evidence
  under review-sha-gating and candidate-integrity disposition
- **THEN** the engine SHALL NOT transition to `pipeline:ready-to-deploy`

#### Scenario: Integrity pass with red CI is not ready

- **WHEN** integrity classification is `semantically_equivalent` or
  `expected_scoped_change` after re-review
- **AND** required CI on the current head is not green
- **THEN** the engine SHALL NOT transition to `pipeline:ready-to-deploy`

---

### Requirement: Regression fixtures SHALL prove integrity dispositions

The engine test suite SHALL include deterministic, injected-deps regression
fixtures that prove at least the following outcomes. Unit tests SHALL perform
no real network, git, or subprocess calls.

#### Scenario: Fixture reproduces README monolith append denial

- **WHEN** a fixture models a repair/restack that appends a large retired
  README monolith after a lean landing-page surface (#793 class)
- **THEN** classification SHALL be `scope_expansion` or the docs landing-page
  invariant SHALL fail closed on the post head
- **AND** readiness SHALL be denied for that head

#### Scenario: Fixture for clean rebase avoids false expansion

- **WHEN** a fixture models a clean rebase that changes commit identity but
  preserves path set and content digests
- **THEN** classification SHALL be `semantically_equivalent`
- **AND** the fixture SHALL assert no scope-expansion invalidation

#### Scenario: Fixture for intended auto-fix forces re-review

- **WHEN** a fixture models an auto-fix that changes declared-scope content and
  advances the candidate SHA
- **THEN** classification SHALL be `expected_scoped_change`
- **AND** prior review for the old SHA SHALL NOT authorize readiness without
  fresh review at the new SHA

#### Scenario: Fixture for restart hydration

- **WHEN** a fixture persists a pre-manifest, claims a mutation, and reloads
  run state
- **THEN** the hydrated pre-manifest SHALL match the persisted digests
- **AND** stale review evidence SHALL NOT authorize readiness for the new head

#### Scenario: Multi-item composition fixture

- **WHEN** a synthetic multi-item sequence accepts an invariant on item A
- **AND** a later repair/restack mutates only item B
- **THEN** item A's accepted invariant and integrity disposition SHALL remain
  intact
- **AND** item B SHALL be classified independently
