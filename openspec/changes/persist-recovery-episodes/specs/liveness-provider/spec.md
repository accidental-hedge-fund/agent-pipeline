## MODIFIED Requirements

### Requirement: Restore SHALL reattach the same supervisor and refresh worker identity

The Liveness Provider SHALL start or reattach the same durable supervisor for an eligible run after it claims the fence. It SHALL keep that run identity. It SHALL refresh worker identity (process id, starttime, boot identity, heartbeat) after attach. It SHALL NOT mint a new Logical Operation. Autonomous restore, cooling wake-up, and bound resume SHALL NOT count as manual reinvocation. systemd, launchd, container, and harness-worker adapters SHALL implement this same attach contract. After attach, the restored supervisor SHALL reconcile outstanding Recovery Episode claims whose side-effect certainty is uncertain before any new mutation. The provider SHALL NOT choose recovery recipes.

#### Scenario: Worker death then restore keeps the same run identity

- **WHEN** the supervisor process exits and the ledger is still non-terminal
- **THEN** restore SHALL reattach using the existing run identity
- **AND** the new worker identity SHALL replace the dead identity on the fence
- **AND** a new Logical Operation SHALL NOT be minted

#### Scenario: Restore reports attached only after supervisor handshake

- **WHEN** restore spawns a replacement supervisor
- **AND** that process has not yet acquired the replacement fence and written a valid worker identity
- **THEN** restore SHALL NOT report attached
- **AND** it SHALL NOT persist the spawned pid as the recorded worker

#### Scenario: systemd and launchd use the same restore contract

- **WHEN** a systemd unit, launchd job, container entrypoint, or harness worker restores after restart
- **THEN** it SHALL invoke the same discover, claim, reattach, follow, and relinquish contract
- **AND** it SHALL NOT carry a host-specific recovery recipe

#### Scenario: Restore reconciles uncertain claims before mutation

- **WHEN** restore attaches after process death
- **AND** a Recovery Episode claim is `started` with uncertain certainty
- **THEN** the restored supervisor SHALL observe the authoritative observer before any new mutation
- **AND** the Liveness Provider SHALL NOT itself replay or repair that side effect

---

## ADDED Requirements

### Requirement: Fenced takeover SHALL invalidate the dead token and SHALL NOT mutate first

After a same-host holder is provably dead, takeover SHALL claim a fresh fenced lease using the existing issue-run lock and durable-loop store lock (process id, starttime, and a new opaque token). The dead holder's token SHALL NOT authorize mutation. Takeover SHALL reconcile uncertain side effects before mutation. Scope SHALL remain single-host. Remote correctness SHALL NOT depend on a new distributed lock or lease service.

#### Scenario: Dead token cannot mutate after takeover

- **WHEN** takeover recovers a dead same-host lock and publishes a new token
- **THEN** a mutating operation that presents the previous token SHALL be refused
- **AND** the refusal SHALL name the new holder

#### Scenario: Takeover of a live holder is refused

- **WHEN** a second launcher observes a live same-host holder
- **THEN** it SHALL NOT take over the fence
- **AND** it SHALL NOT start a duplicate supervisor
