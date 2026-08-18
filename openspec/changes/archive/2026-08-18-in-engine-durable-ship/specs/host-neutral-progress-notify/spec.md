## ADDED Requirements

### Requirement: Host ship phrase SHALL exec the Pipeline ship CLI

Host skills for Hermes, OpenClaw, Claude, Codex, Grok, omp, and OpenCode SHALL map operator phrase `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`. If the CLI is blocking, the host MAY detach one process. Status and stop SHALL read `pipeline ship status` / the Pipeline ship ledger. Notify SHALL fire on ship phase transitions, item transitions, and terminal failure, using the exact child-run identities stored by that ship. Hosts SHALL NOT notify from a Tugboat-owned state machine as the source of truth.

#### Scenario: Phrase becomes the milestone CLI

- **WHEN** an operator says `Ship milestone v1.39.3` on a configured host
- **THEN** the host SHALL exec `pipeline ship --milestone v1.39.3`
- **AND** it SHALL NOT start Tugboat as the ship owner

#### Scenario: Notify follows the ship ledger

- **WHEN** the ship ledger advances from train to release, or an item merges, or the ship fails
- **THEN** the host notify path SHALL emit a material event for that transition or failure
- **AND** the event SHALL name the ship milestone and the exact child-run identity
- **AND** it SHALL NOT infer the ship from a host-global latest-run directory

### Requirement: Hermes SHALL re-invoke the same ship command after a non-human failure

On notify of a non-human ship failure, Hermes SHALL re-invoke the same `pipeline ship --milestone …` argv and no other recoverer. Hermes SHALL NOT classify the failure, delete a run directory, wait a cooldown, or invent `pipeline single` / `pipeline loop`. If ship status reports human authority, Hermes SHALL stop and report that state.

#### Scenario: Non-human failure re-invokes ship

- **WHEN** Hermes receives a non-human failure notify for milestone `v1.39.3`
- **THEN** it SHALL exec `pipeline ship --milestone v1.39.3` again
- **AND** it SHALL NOT classify, janitor a run dir, or invoke `single` / `loop`

#### Scenario: Human authority stops Hermes

- **WHEN** `pipeline ship status` reports a human-authority stop
- **THEN** Hermes SHALL stop and report that human-authority state
- **AND** it SHALL NOT re-invoke ship
