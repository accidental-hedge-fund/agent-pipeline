# issue-run-lock Specification

## Purpose
TBD - created by archiving change detach-lock-domain-scope. Update Purpose after archive.
## Requirements
### Requirement: Issue-run mutual exclusion SHALL be keyed by domain and issue number

The engine SHALL provide a single host-local issue-run lock identity of `(domain, issueNumber)`
for pipeline work on a given issue. The lock key SHALL include a non-empty domain identity
(the same domain string used by foreground advance, typically the configured or derived
pipeline domain) and the integer issue number. The lock key SHALL NOT be issue-number-only.
Distinct domains with the same issue number SHALL resolve to distinct lock identities and
SHALL NOT mutually exclude each other on the same host.

#### Scenario: Cross-domain same issue number does not collide

- **WHEN** domain `repo-a` holds the issue-run lock for issue `42`
- **AND** domain `repo-b` attempts to acquire the issue-run lock for issue `42` on the same host
- **THEN** the `repo-b` acquire SHALL succeed
- **AND** both locks SHALL remain independently held until each holder releases

#### Scenario: Same domain and issue are exclusive

- **WHEN** domain `repo-a` already holds the issue-run lock for issue `42` with a live holder
- **AND** a second acquire for domain `repo-a` and issue `42` is attempted on the same host
- **THEN** the second acquire SHALL fail or wait according to the caller's acquire policy
- **AND** SHALL NOT grant concurrent exclusive ownership of the same key

#### Scenario: Different issues under one domain remain concurrent

- **WHEN** domain `repo-a` holds the issue-run lock for issue `10`
- **AND** domain `repo-a` attempts to acquire the issue-run lock for issue `11` on the same host
- **THEN** the acquire for issue `11` SHALL succeed without waiting on issue `10`

---

### Requirement: Foreground advance and detach SHALL share one issue-run lock API and identity

Foreground advance and detach SHALL acquire and release issue-run mutual exclusion through
one shared lock API keyed by `(domain, issueNumber)`, including the detached wrapper's lock
acquisition and handshake. They SHALL NOT maintain separate lock path schemes whose scopes
differ (issue-only vs domain+issue). A live holder that entered via detach SHALL prevent a
concurrent foreground advance for the same key from treating the issue as free, and a live
holder that entered via foreground advance SHALL prevent a concurrent detach for the same
key from treating the issue as free. The shared API and its path construction SHALL be
unit-testable via injected filesystem or lock seams without real network, git, or subprocess
calls.

#### Scenario: Detach holder blocks foreground advance for the same key

- **WHEN** a detached run holds the issue-run lock for `(domain=D, issue=N)` with a live process
- **AND** foreground advance for domain `D` and issue `N` attempts to enter the protected section
- **THEN** the foreground advance SHALL observe the lock as held
- **AND** SHALL NOT proceed as if no concurrent run exists for that key

#### Scenario: Foreground holder blocks detach for the same key

- **WHEN** a foreground advance holds the issue-run lock for `(domain=D, issue=N)` with a live process
- **AND** `pipeline run N --detach` (or equivalent) for domain `D` attempts to acquire the issue-run lock
- **THEN** the detach path SHALL observe the lock as held
- **AND** SHALL reject or time out without starting a concurrent exclusive run for that key

#### Scenario: Shared path construction is domain-scoped

- **WHEN** the shared lock API builds the lock path or identity for domain `D` and issue `N`
- **THEN** the resulting identity SHALL encode both `D` and `N`
- **AND** SHALL differ from the identity for domain `E` and issue `N` when `D ≠ E`

---

### Requirement: The issue-run lock SHALL remain host-local with no cross-host mutual exclusion claim

The issue-run lock SHALL provide mutual exclusion only among processes that share the same
host-local lock filesystem (the same machine's lock path). The engine SHALL NOT claim or
implement cross-host distributed locking for this primitive. Project operating guidance SHALL
state that single-host operation is the supported concurrency scope for the issue-run lock,
consistent with the host-local disposition of other `/tmp` PID lock sites. Cross-host
coordination for this lock remains out of scope.

#### Scenario: Docs state host-local scope for the unified lock

- **WHEN** the project's operating guidance describing concurrency locks is read
- **THEN** it SHALL state that the issue-run lock used by advance and detach is host-local
- **AND** SHALL NOT claim mutual exclusion across distinct hosts for that lock

#### Scenario: No distributed lock service is required

- **WHEN** this capability is implemented
- **THEN** the engine SHALL NOT introduce a new cross-host coordination service or lease
  system solely to back the issue-run lock
- **AND** SHALL NOT add an autonomous merge path as part of this capability

