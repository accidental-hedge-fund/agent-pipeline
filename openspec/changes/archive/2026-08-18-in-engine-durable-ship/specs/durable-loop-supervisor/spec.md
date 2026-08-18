## ADDED Requirements

### Requirement: Re-invoke of the same ship SHALL NOT reuse a dead loop into supervisor_no_progress

When a ship or train re-enters after a dead holder, the supervisor SHALL continue the same item from its last durable stage. Reusing a prior loop run id whose holder is dead SHALL NOT keep that run in a wait cycle. The supervisor SHALL NOT record stop reason `supervisor_no_progress` because a dead prior run produced `coexistence_wait` or a leftover `workflow-engine-defect`. A new or continued driver MAY attach to live child identities that are still live; a corpse run is not live.

#### Scenario: Re-ship after kill does not stop supervisor_no_progress

- **WHEN** a prior loop run failed after SIGTERM and its holder is dead
- **AND** `pipeline ship --milestone` for the same milestone is invoked again
- **THEN** the supervisor SHALL resume the same issue
- **AND** it SHALL NOT stop with reason `supervisor_no_progress`

#### Scenario: Reused corpse run id is not a live wait

- **WHEN** the only recorded loop id for the item is a prior run whose holder is dead
- **THEN** the supervisor SHALL NOT treat that run id as a live coexistence holder
- **AND** it SHALL take over the item instead of waiting on that id

### Requirement: Leftover recovered block SHALL NOT stop a later ready-to-deploy ship item

When live labels include `pipeline:ready-to-deploy` and do not include `blocked`, and #1095 recovered-block classification is ok, a ship or merge-mode train SHALL merge that item. A leftover `loop_item_blocked` event or leftover `blocked_theme` on a ready ledger item SHALL NOT STOP the ship and SHALL NOT cause the driver to implement a newer sibling instead.

#### Scenario: Leftover implementation-ci plus live R2D merges

- **WHEN** ship or `train --merge` observes issue A with live `pipeline:ready-to-deploy`, no live `blocked`, an open MERGEABLE PR, and a leftover `loop_item_blocked` / `blocked_theme`
- **THEN** it SHALL merge A
- **AND** it SHALL NOT STOP the ship solely for that leftover block
- **AND** it SHALL NOT implement a newer sibling while A's PR remains open
