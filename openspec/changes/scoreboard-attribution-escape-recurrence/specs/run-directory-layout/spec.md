## ADDED Requirements

### Requirement: run.json engine identity SHALL record commit SHA when resolvable

The orchestrator SHALL include a `commit_sha` field on `run.json.engine` (git commit of the
engine root) when writing `run.json` at run-directory creation and that SHA is resolvable
from the engine installation. When the SHA cannot be resolved, `commit_sha` SHALL be
omitted or set to null without failing run-directory creation. Existing `version`, `root`,
and `templates_fingerprint` fields SHALL remain. `run.json` SHALL remain write-once (not
refreshed on later dispatch cycles).

#### Scenario: Resolvable engine SHA is recorded at init

- **WHEN** `initRunDir(...)` is called and the engine root yields git commit `deadbeef…`
- **THEN** `run.json.engine.commit_sha` SHALL equal that commit
- **AND** `engine.version`, `engine.root`, and `engine.templates_fingerprint` SHALL still
  be present when otherwise resolvable

#### Scenario: Unresolvable engine SHA does not fail run init

- **WHEN** engine version resolves but git SHA cannot be determined
- **THEN** `run.json` SHALL still be written successfully
- **AND** `engine.commit_sha` SHALL be absent or null
- **AND** other engine fields SHALL remain as today

#### Scenario: Engine identity is not rewritten mid-run

- **WHEN** the orchestrator re-enters the dispatch loop for the same run-id after the
  on-disk engine changes
- **THEN** `run.json.engine` including `commit_sha` SHALL remain the originally pinned
  values

---

### Requirement: run.json SHALL persist an explicit discovery-channel stamp for new runs

When writing `run.json` at run-directory creation, the orchestrator SHALL persist a
`discovery_channel` field using the closed discovery-channel vocabulary. Ordinary issue
advance and durable-loop item execution SHALL default this field to `live-run` when the
caller does not supply a more specific channel. The field is the run-level discovery-
attribution marker: scoreboard collectors SHALL inherit event-level discovery-channel
from it only when the field is present. Historical `run.json` files without
`discovery_channel` SHALL remain readable and SHALL NOT be treated as `live-run` merely
because `engine.version` (or other pre-#763 engine identity) is present.
`run.json` SHALL remain write-once (not refreshed on later dispatch cycles).

#### Scenario: New run stamps discovery_channel live-run by default

- **WHEN** `initRunDir(...)` is called for an ordinary advance without an explicit
  discovery channel override
- **THEN** `run.json.discovery_channel` SHALL equal `live-run`

#### Scenario: Explicit channel override is persisted

- **WHEN** `initRunDir(...)` is called with discovery channel `review-batch`
- **THEN** `run.json.discovery_channel` SHALL equal `review-batch`

#### Scenario: Historical run.json without discovery_channel is not invented as live-run

- **WHEN** a scoreboard collector reads a pre-#763 `run.json` that has `engine.version`
  but no `discovery_channel` field
- **THEN** the run-level discovery channel SHALL be treated as missing-attribution
- **AND** collectors SHALL NOT count that arrival as `live-run`
