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
