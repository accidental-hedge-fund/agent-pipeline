## MODIFIED Requirements

### Requirement: Dry-run SHALL disclose release-when-complete intent without side effects

The merge-queue command SHALL, when run in dry-run with release-when-complete
enabled, report whether release prepare **would** run, including the intended
version and either a would-prepare confirmation or a skip reason (incomplete
queue, missing version, or other gate). Dry-run SHALL evaluate completeness
against **current** state (not projected post-merge emptiness of a non-empty
queue): would-prepare only when the current queue is already complete. Dry-run
SHALL NOT open a release PR, SHALL NOT write release-managed files
(`package.json`, `core/package.json`, `ROADMAP.md`, the four generated host
SKILLs),
and SHALL NOT tag, publish, or merge. Dry-run SHALL NOT recreate `plugin/`.

#### Scenario: Dry-run on an already-complete queue reports would-prepare

- **WHEN** dry-run is used with release-when-complete and a version, and the
  current queue is complete
- **THEN** the output SHALL state that release prepare would run for that version
- **AND** no release PR is created
- **AND** no release-managed paths are mutated
- **AND** `plugin/` SHALL NOT be created

#### Scenario: Dry-run on a non-empty queue reports would-not-prepare

- **WHEN** dry-run is used with release-when-complete and remaining R2D
  candidates exist
- **THEN** the output SHALL state that release prepare would not run
- **AND** SHALL include a skip reason naming remaining candidates
- **AND** no release PR is created

#### Scenario: Dry-run without the flag never mentions preparing a release as an action

- **WHEN** dry-run runs without release-when-complete enabled
- **THEN** the planned actions SHALL NOT include preparing a release PR
