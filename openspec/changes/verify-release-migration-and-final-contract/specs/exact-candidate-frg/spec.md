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

The product SHALL provide ownership-safe cleanup and migration behavior for known failed synthetic artifacts. Cleanup SHALL mutate only resources whose current identity matches recorded synthetic provenance. It SHALL NOT close unrelated issues or pull requests. It SHALL NOT delete user worktrees. It SHALL NOT merge. It SHALL NOT hand-edit ledgers. It SHALL NOT delete diagnostic evidence to reset budgets. Tests of this behavior SHALL use injected I/O or isolated real Git fixtures and SHALL NOT be treated as proof that an operator completed live cleanup. The operator SHALL perform actual scoped failed-artifact cleanup after those checks.

#### Scenario: Owned failed synthetic identity can be cleaned

- **WHEN** a recorded failed synthetic fixture still matches its issue, PR, branch, or worktree identity
- **THEN** ownership-safe cleanup SHALL close or delete only that owned identity
- **AND** it SHALL persist the classification or proof first
- **AND** it SHALL record cleanup debt when the mutation is uncertain

#### Scenario: Unrelated identities are left unchanged

- **WHEN** a cleanup target no longer matches the recorded synthetic identity
- **OR** the target is an unrelated issue, pull request, or user worktree
- **THEN** cleanup SHALL leave that target unchanged
- **AND** SHALL record cleanup debt rather than broaden its scope

#### Scenario: Simulated cleanup is not operator proof

- **WHEN** an injected-I/O or isolated Git fixture test reports successful ownership-safe cleanup
- **THEN** that result SHALL prove product behavior only
- **AND** it SHALL NOT be treated as proof that an operator completed live cleanup
