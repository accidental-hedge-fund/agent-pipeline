## ADDED Requirements

### Requirement: The supervisor process-identity heartbeat SHALL compose with an independent cadence refresh

In addition to refreshing the process-identity heartbeat on cycle completion, the durable loop supervisor SHALL support controller-owned independent cadence heartbeat refresh while a cycle is blocked in whole-item dispatch, expected wait, or recovery backoff, as required by `controller-independent-health`. Independent cadence refresh SHALL compose with cycle-bound refresh and SHALL NOT replace the process-identity record, the run lock, or the action-evidence trail. When the #890 macro-controller is the outer owner, the supervisor MAY remain the item driver whose process evidence feeds factory status; requirements here still apply whenever the supervisor is the live holder refreshing process identity.

#### Scenario: Long dispatch no longer freezes heartbeat until cycle end

- **WHEN** the supervisor is inside a single long dispatch that exceeds the independent
  heartbeat interval
- **THEN** process-identity `heartbeat_at` SHALL advance before that dispatch returns
- **AND** the advance SHALL NOT require completing the supervisor cycle

#### Scenario: Cycle-bound evidence remains intact

- **WHEN** independent heartbeat refreshes occur during a cycle
- **THEN** the supervisor SHALL still write normal cycle-completion action-evidence when the
  cycle finishes
- **AND** the process-identity record SHALL remain distinct from the run lock

#### Scenario: Independent heartbeat uses the injectable store seam

- **WHEN** unit tests drive supervisor heartbeat refresh
- **THEN** they SHALL do so through the store's injectable seam with no real process, network,
  or git call
