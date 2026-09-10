## ADDED Requirements

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

#### Scenario: Ordinary exact-candidate records are not mutated

- **WHEN** cleanup receives an exact-candidate record that lacks persisted failed-synthetic classification
- **THEN** it SHALL produce no mutating cleanup actions
- **AND** it SHALL record cleanup debt rather than close recorded issues or pull requests

#### Scenario: Branch or worktree without recorded identity is cleanup debt

- **WHEN** a recorded failed synthetic fixture has a null recorded branch SHA
- **OR** the observed worktree has no ownership identity
- **OR** the delete mutation cannot enforce the recorded identity atomically
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
