# run-directory-layout

## MODIFIED Requirements

### Requirement: run.json is written at run directory creation with immutable identity metadata
Immediately after creating the run directory, the orchestrator SHALL write `run.json` containing: `schema_version` (integer, initial value `1`), `run_id` (string), `issue` (integer), `repo` (string, `owner/name` format), `profile` (active profile name string, or `null` if not set), `started_at` (ISO 8601 UTC timestamp), and `engine` (object, or omitted when the engine identity cannot be resolved) carrying `version` (engine version string), `root` (resolved engine root path), and `templates_fingerprint` (fingerprint of the pinned prompt-template snapshot). The `engine` object pins the skill snapshot the run executes against, so a later engine change is detectable and attributable. `run.json` is written once and SHALL NOT be modified after creation.

#### Scenario: run.json written at init with all required fields
- **WHEN** `initRunDir(...)` is called with issue, repo, profile, and timestamp
- **THEN** `run.json` SHALL exist in the run directory
- **AND** SHALL contain `schema_version: 1`, `run_id`, `issue`, `repo`, `profile`, and `started_at`

#### Scenario: run.json records the pinned engine identity
- **WHEN** `initRunDir(...)` is called and the engine identity resolves
- **THEN** `run.json` SHALL contain an `engine` object with `version`, `root`, and `templates_fingerprint`

#### Scenario: An unresolvable engine identity omits the field rather than failing the run
- **WHEN** the engine version or template fingerprint cannot be resolved at run-directory creation
- **THEN** `run.json` SHALL be written with its other fields unchanged and the `engine` field omitted
- **AND** run-directory creation SHALL succeed

#### Scenario: run.json is not overwritten on subsequent dispatch cycles
- **WHEN** the orchestrator re-enters the dispatch loop for the same run-id
- **THEN** `run.json` SHALL remain unchanged from its initial write
- **AND** the `engine` object SHALL NOT be refreshed to the current on-disk engine
