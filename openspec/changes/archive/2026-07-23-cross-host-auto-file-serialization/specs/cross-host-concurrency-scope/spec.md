## ADDED Requirements

### Requirement: The engine SHALL declare single-host operation as the supported concurrency scope for its host-local locks

The engine SHALL document, in its project-level operating guidance, that its `/tmp` PID lock sites —
the per-issue/domain advance lock, the queue-batch serialization, and the live-planning marker — are
**host-local** and provide no mutual exclusion across distinct hosts, and that single-host operation
is the supported concurrency scope for those sites. This declaration SHALL make the constraint
explicit rather than implicit, so an operator is not misled into assuming cross-host serialization
the `/tmp` lock cannot provide. The declaration SHALL NOT introduce any auto-merge path or new
coordination service.

#### Scenario: Project docs state the single-host scope

- **WHEN** the project's operating guidance is read
- **THEN** it SHALL state that the `/tmp` lock sites are host-local and that single-host operation is
  the supported concurrency scope for them

#### Scenario: The auto-file path is exempt from the single-host limitation

- **WHEN** the docs describe the single-host scope of the `/tmp` locks
- **THEN** they SHALL note that the auto-file dedup + rate-cap path is separately hardened to be
  cross-host safe via GitHub-authored issue state (per `papercut-auto-file`)

---

### Requirement: The engine's host-local lock sites SHALL each carry a recorded cross-host safety assessment

Each `/tmp` lock site SHALL have a recorded assessment of what it guards and what its cross-host
failure mode is — covering the advance lock, the queue-batch serialization, and the live-planning marker — so the
decision to leave it single-host is a documented engineering judgement rather than an oversight. The
assessment SHALL establish that each such site guards **host-local** resources whose cross-host
failure mode does not produce a persistent, irreversible shared artifact (unlike an auto-filed GitHub
issue). Extending cross-host coordination to these sites SHALL be treated as deferred architectural
work rather than part of this change.

#### Scenario: Each lock site has a recorded disposition

- **WHEN** the cross-host assessment is reviewed
- **THEN** the advance lock, the queue-batch serialization, and the live-planning marker SHALL each
  have a recorded statement of what it guards and its cross-host failure mode
- **AND** each SHALL be dispositioned as single-host scope with a stated rationale

#### Scenario: Host-local lock behavior is unchanged by this change

- **WHEN** this change is implemented
- **THEN** the advance lock, the queue-batch serialization, and the live-planning marker SHALL retain
  their existing runtime behavior
- **AND** no new coordination service or auto-merge path SHALL be introduced for them
