# exact-candidate-frg Specification

## Purpose
TBD - created by archiving change simplify-frg-exact-pair. Update Purpose after archive.
## Requirements
### Requirement: FRG SHALL bind one current exact engine candidate

The FRG runner SHALL fetch and select one full commit SHA `C` from the current `origin/main`, establish a candidate epoch for that SHA, and use the shared candidate resolve-and-prepare gate before candidate execution. Templates, manifest data, launcher code, and the nested `core/package-lock.json` SHALL be read from the prepared candidate root. An installed engine, operator working tree, fixture pull-request head, or later `origin/main` head SHALL NOT substitute for `C`.

#### Scenario: Current main candidate supplies every executable input

- **WHEN** a new FRG candidate epoch begins
- **THEN** the recorded candidate SHA SHALL equal the freshly observed `origin/main` SHA
- **AND** the launcher, clean-docs and clean-openspec templates, manifest data, and nested lockfile SHALL resolve beneath the prepared root for that SHA
- **AND** the two fixture PR heads SHALL be recorded as identities distinct from the engine candidate

#### Scenario: Stale operator sources cannot satisfy the gate

- **WHEN** the operator working tree or installed engine differs from candidate `C`
- **THEN** FRG SHALL continue to execute and observe the prepared root for `C`
- **AND** it SHALL fail closed if candidate-owned inputs cannot be obtained

### Requirement: FRG SHALL reconcile one intended pair of exactly two fixtures

Before the first remote create, the release-owned record SHALL bind one intended clean-docs slot and one intended clean-openspec slot to candidate `C`, with stable provenance identities that can be found authoritatively after restart or an uncertain response. The runner SHALL reconcile all matching remote issues before each create. It SHALL adopt the unique issue for an unfilled slot, create only a slot proven absent, and treat duplicate or ambiguous matches as a gate defect. It SHALL NOT create, select, or launch a third fixture issue for the epoch.

#### Scenario: Partial creation resumes the missing slot only

- **WHEN** the clean-docs issue is authoritatively present and the clean-openspec slot is proven absent
- **THEN** resumed creation SHALL adopt the existing clean-docs identity
- **AND** SHALL create at most one clean-openspec issue
- **AND** SHALL persist the completed pair before dispatch

#### Scenario: Uncertain create response is reconciled before retry

- **WHEN** a create response is lost or otherwise has uncertain side-effect certainty
- **THEN** the runner SHALL re-observe remote issues using the intended slot provenance
- **AND** SHALL NOT retry creation until absence for that slot is authoritatively proven

#### Scenario: Duplicate match prevents a third issue

- **WHEN** reconciliation finds more than one matching issue for either intended slot or finds a foreign third issue claiming the pair identity
- **THEN** FRG SHALL classify the condition as a gate defect
- **AND** SHALL create no issue and dispatch no replacement pair

### Requirement: FRG SHALL use the unchanged ordinary loop for explicit fixture identities

The candidate SHALL invoke the ordinary pipeline loop with an explicit work list containing exactly the two recorded issue numbers. The fixture run SHALL use repository-configured implementer and reviewer workers, ordinary stage and review gates, ordinary lifecycle ownership, and the domain-aware issue-run locks. The existing same-host release exclusion SHALL remain in force. FRG SHALL NOT introduce cross-host coordination or a second recovery owner and SHALL NOT select fixtures by a broad label, merge fixture pull requests, repair pipeline engine code through fixture work, weaken ordinary gates, auto-file repair issues, or start a replacement pair after an unsuccessful observation.

#### Scenario: Dispatch names exactly the recorded pair

- **WHEN** both fixture identities are reconciled and candidate `C` is prepared
- **THEN** the ordinary loop dispatch SHALL name exactly those two issue numbers
- **AND** SHALL NOT use a label selector or include another issue

#### Scenario: Ready fixtures remain unmerged

- **WHEN** either ordinary fixture reaches `pipeline:ready-to-deploy`
- **THEN** FRG SHALL observe the open pull request without invoking a merge surface
- **AND** cleanup SHALL NOT merge it

#### Scenario: Existing ownership boundaries remain authoritative

- **WHEN** FRG dispatches the recorded pair on a host
- **THEN** the same-host release exclusion and ordinary domain-aware issue locks SHALL govern concurrency
- **AND** FRG SHALL NOT add a cross-host scheduler, a second lifecycle ledger, or a second recovery owner

### Requirement: FRG SHALL accept only authoritative current-head completion evidence

For each fixture, the release-owned observer SHALL independently obtain current forge and pipeline state proving: the expected issue-template provenance; one current open and unmerged pull request; `pipeline:ready-to-deploy`; current successful required CI for that exact PR head; accepted independent review whose `reviewed_head_sha` equals that exact current PR head; and current passed Tester evidence for that head and effective worker configuration. The result SHALL fail closed when any required observer is unavailable or inconsistent. Labels, comments, public hashes, worker-authored booleans, fixture files, process exit, or a run-complete event SHALL NOT independently prove completion.

#### Scenario: Current green unmerged head passes

- **WHEN** both issues have the expected provenance and each current PR head has ready-to-deploy state, successful required CI, accepted independent review, and passed Tester evidence
- **AND** both pull requests are open and unmerged
- **THEN** the observer SHALL record a proven FRG pass for candidate `C`

#### Scenario: Forged or stale claim does not pass

- **WHEN** a fixture worker writes a pass claim, comment, hash, or evidence file without matching authoritative observations
- **OR** CI, review, or Tester evidence names a prior or different PR head
- **THEN** the observer SHALL refuse a pass
- **AND** SHALL retain the mismatched evidence in the classified result

#### Scenario: Prior-head review remains observable but is not exact-head proof

- **WHEN** review currency qualifies a prior-head review for the current diff or successor head
- **AND** the review's `reviewed_head_sha` does not equal the current PR head
- **THEN** the observer MAY retain the currency-qualified review in the classified result
- **AND** SHALL refuse an exact FRG pass
- **AND** SHALL NOT classify current-head `changes_requested` from that prior-head review

#### Scenario: Merged fixture does not pass

- **WHEN** authoritative forge state reports either fixture pull request as merged
- **THEN** the observer SHALL refuse a pass even if the ready-to-deploy label and other evidence remain present

### Requirement: FRG SHALL persist one compact observer-owned result

The release-owned result SHALL be stored outside fixture-worker control and SHALL contain a schema version, candidate epoch and `C`, candidate template and lockfile identities, both intended slots and issue identities, ordinary logical run identities, current PR heads, effective implementer/reviewer and gate configuration identities, normalized authoritative observations, overall outcome, timestamps, and cleanup facts. The record SHALL distinguish ingress claims from authoritative proof and SHALL be sufficient to re-observe the same candidate and pair after restart.

#### Scenario: Restart resumes the recorded identities

- **WHEN** the FRG process restarts after candidate, slot, issue, or run identities have been persisted
- **THEN** it SHALL resume observation of those identities
- **AND** SHALL NOT infer a new candidate, pair, or run from labels or newest-state heuristics

#### Scenario: Fixture worker cannot rewrite observer evidence

- **WHEN** a fixture branch changes files or emits worker-controlled output
- **THEN** those changes SHALL NOT modify the release-owned result store
- **AND** SHALL NOT replace independently observed evidence in the result

### Requirement: FRG SHALL classify unsuccessful observations without losing ownership

Every non-passing observation SHALL classify as exactly one of: `ordinary_review_revision`, `external_or_transient_inconclusive`, `exact_candidate_regression`, or `gate_defect`. Ordinary review revision SHALL return the affected issue to ordinary pipeline treatment for the same head or its normal successor. External or transient inconclusive state SHALL remain an owned external-condition wait with a live re-observation condition. Exact-candidate regression SHALL retain failed evidence for `C` and block that candidate epoch without fixture-side engine repair. Gate defect SHALL retain the evidence and require correction of the shared selector, reconciliation, evidence classifier, gate, or owning controller contract with deterministic regression coverage. None of these outcomes SHALL create a replacement pair or silently rebind `C`.

#### Scenario: Review revision remains ordinary work

- **WHEN** authoritative review requests a product revision through the normal pipeline
- **THEN** FRG SHALL classify `ordinary_review_revision`
- **AND** the same issue SHALL remain under ordinary pipeline lifecycle ownership

#### Scenario: External observer outage remains an owned wait

- **WHEN** CI, forge, or another authoritative observer cannot provide a conclusive current result
- **THEN** FRG SHALL classify `external_or_transient_inconclusive`
- **AND** SHALL retain an external-condition wait with a named live probe and wake condition
- **AND** SHALL NOT manufacture human authority or a failed candidate

#### Scenario: Demonstrated candidate regression retains exact evidence

- **WHEN** authoritative observations prove that candidate `C` caused an ordinary gate failure on the intended fixture
- **THEN** FRG SHALL classify `exact_candidate_regression`
- **AND** SHALL retain the candidate and fixture evidence without launching repair work through the fixture

#### Scenario: Shared gate defect requires class-level correction

- **WHEN** FRG failure is caused by candidate selection, reconciliation, evidence classification, gate logic, or controller contract
- **THEN** FRG SHALL classify `gate_defect`
- **AND** completion of the correction SHALL require deterministic coverage of the shared fault class rather than a fixture-local exception

### Requirement: Candidate movement SHALL invalidate the existing proof epoch

The observer SHALL freshly compare `origin/main` with `C` at verification and resume boundaries. Movement SHALL make the existing result stale and SHALL require a separately identified candidate epoch and complete re-proof. Evidence, fixtures, or outcomes from the earlier epoch SHALL NOT be rebound to the newer candidate.

#### Scenario: Main moves during observation

- **WHEN** `origin/main` changes from `C1` to `C2` before the `C1` result is accepted
- **THEN** the `C1` evidence SHALL be marked stale for release use
- **AND** `C2` SHALL require a new epoch, prepared candidate, intended pair, ordinary runs, and authoritative proof
- **AND** the system SHALL NOT rewrite the `C1` record to name `C2`

### Requirement: FRG SHALL persist outcome before ownership-safe cleanup

The observer SHALL persist the final pass or classified non-pass result before attempting cleanup. Cleanup SHALL be limited to resources proven owned by the recorded fixture identities, SHALL use compare-and-swap or equivalent identity checks where remote state may have changed, and SHALL never merge. Cleanup failure or uncertain ownership SHALL be recorded as cleanup debt without deleting evidence, resetting creation limits, changing the proven outcome, or manufacturing success.

#### Scenario: Cleanup failure does not invalidate a proven pass

- **WHEN** a proven pass is durably stored and ownership-safe cleanup later fails or becomes uncertain
- **THEN** the pass SHALL remain proven for candidate `C`
- **AND** the result SHALL report the outstanding cleanup debt and affected identity

#### Scenario: Ownership mismatch prevents cleanup mutation

- **WHEN** a cleanup target no longer matches the recorded issue, PR, branch, or worktree identity
- **THEN** cleanup SHALL leave that target unchanged
- **AND** SHALL record cleanup debt rather than broaden its scope

### Requirement: Historical-failed-ship-evidence SHALL NOT authorize the current candidate

Failed or prior ship, FRG, scorer, or attestor ledgers and files SHALL remain as historical-failed-ship-evidence. The product SHALL treat them as superseded. They SHALL NOT be current-candidate authority and SHALL NOT be a prerequisite for a new exact-candidate proof. A new proof SHALL NOT require a working old scorer or attestor. A historical pass SHALL NOT be authority for the current candidate.

#### Scenario: Historical HMAC pass does not prove the current candidate

- **WHEN** an on-disk `.agent-pipeline/frg/<version>/latest.json` records `pass: true` for a prior candidate
- **AND** the current candidate SHA differs
- **THEN** exact-candidate verification SHALL ignore that file as current-candidate authority
- **AND** SHALL require fresh authoritative forge, CI, review, Tester, readiness, and no-merge observations for the current pair

#### Scenario: Absent old scorer does not block a new proof

- **WHEN** the old scorer or attestor is absent or unreadable
- **AND** current authoritative observations prove the exact pair
- **THEN** exact-candidate verification SHALL accept the current proof
- **AND** SHALL NOT fail because the old scorer is missing

### Requirement: Known failed synthetic artifacts SHALL migrate under ownership-safe cleanup

The product SHALL provide ownership-safe cleanup and migration behavior for known failed synthetic artifacts. Cleanup SHALL require an explicit persisted failed-synthetic classification before any mutation. Failed-synthetic classification SHALL persist only when the record already has synthetic-fixture provenance from the fixture create path. The product SHALL NOT infer synthetic ownership from an FRG outcome. Ordinary exact-candidate records SHALL produce no mutating cleanup actions. Cleanup SHALL mutate only resources whose current identity matches recorded synthetic provenance. Branch and worktree deletion SHALL require a recorded non-null ownership identity and SHALL enforce that identity atomically on the mutation. A null recorded branch SHA or an observed worktree with no identity SHALL NOT authorize deletion; those targets SHALL become cleanup debt. Remote issue or pull request close SHALL be recorded as cleanup debt unless the mutation API can enforce the observed provenance atomically. It SHALL NOT close unrelated issues or pull requests. It SHALL NOT delete user worktrees. It SHALL NOT merge. It SHALL NOT hand-edit ledgers. It SHALL NOT delete diagnostic evidence to reset budgets. Tests of this behavior SHALL use injected I/O or isolated real Git fixtures and SHALL NOT be treated as proof that an operator completed live cleanup. The operator SHALL perform actual scoped failed-artifact cleanup after those checks.

#### Scenario: Owned failed synthetic identity can be cleaned

- **WHEN** a recorded failed synthetic fixture still matches its issue, PR, branch, or worktree identity
- **AND** the mutation can enforce that identity atomically
- **THEN** ownership-safe cleanup SHALL close or delete only that owned identity
- **AND** it SHALL persist the classification or proof first
- **AND** it SHALL record cleanup debt when the mutation is uncertain

#### Scenario: Failed outcome without synthetic-fixture provenance is not classified

- **WHEN** an exact-candidate FRG records `gate_defect`, `exact_candidate_regression`, or `stale_candidate`
- **AND** the record has no persisted synthetic-fixture provenance from the fixture create path
- **THEN** the product SHALL NOT persist `known_failed_synthetic` classification
- **AND** cleanup SHALL produce no mutating cleanup actions

#### Scenario: Failed outcome does not infer synthetic classification

- **WHEN** an exact-candidate FRG records `gate_defect`, `exact_candidate_regression`, or `stale_candidate`
- **AND** the record has persisted synthetic-fixture provenance from the fixture create path
- **AND** the record has no persisted failed-synthetic classification
- **THEN** the product SHALL NOT persist `known_failed_synthetic` classification from that outcome
- **AND** cleanup SHALL produce no mutating cleanup actions

#### Scenario: Ordinary exact-candidate records are not mutated

- **WHEN** cleanup receives an exact-candidate record that lacks persisted failed-synthetic classification
- **THEN** it SHALL produce no mutating cleanup actions
- **AND** it SHALL record cleanup debt rather than close recorded issues or pull requests

#### Scenario: Branch or worktree without recorded identity is cleanup debt

- **WHEN** a recorded failed synthetic fixture has a null recorded branch SHA
- **OR** the observed worktree has no ownership identity
- **OR** the delete mutation cannot enforce the recorded identity atomically
- **OR** the branch or worktree observer is unavailable
- **THEN** cleanup SHALL leave that branch or worktree unchanged
- **AND** SHALL record cleanup debt

#### Scenario: Remote close without atomic ownership is cleanup debt

- **WHEN** a recorded failed synthetic issue or pull request still matches its observed identity
- **AND** the close mutation cannot enforce that observed provenance atomically
- **THEN** cleanup SHALL leave that issue or pull request unchanged
- **AND** SHALL record cleanup debt

#### Scenario: Unrelated identities are left unchanged

- **WHEN** a cleanup target no longer matches the recorded synthetic identity
- **OR** the target is an unrelated issue, pull request, or user worktree
- **THEN** cleanup SHALL leave that target unchanged
- **AND** SHALL record cleanup debt rather than broaden its scope

#### Scenario: Simulated cleanup is not operator proof

- **WHEN** an injected-I/O or isolated Git fixture test reports successful ownership-safe cleanup
- **THEN** that result SHALL prove product behavior only
- **AND** it SHALL NOT be treated as proof that an operator completed live cleanup

