## ADDED Requirements

### Requirement: run.json engine identity SHALL record the engine track

When the orchestrator writes `run.json` with an `engine` identity object, that object SHALL
include a `track` field whose value is `"pinned"` or `"candidate"`, classifying whether the run
executes the production pin install or a candidate soak build. The existing `version`, `root`,
and `templates_fingerprint` fields remain required as specified by the baseline engine-identity
requirement. When the production pin version is known at run start, the engine object MAY also
include `pin_version` (string) equal to the pin target. When a git SHA for the executing engine
is resolvable without network, the engine object MAY include `git_sha`. Absence of optional
`pin_version` / `git_sha` SHALL NOT invalidate a run that still records `track`, `version`,
`root`, and `templates_fingerprint`. Historical run directories created before this field existed
SHALL remain readable; consumers SHALL treat a missing `track` as unknown rather than inventing
a track.

#### Scenario: Pinned-track run records track pinned

- **WHEN** a run directory is created for an execution classified as the production pin track
- **THEN** `run.json` `engine.track` SHALL equal `"pinned"`
- **AND** `engine.version` SHALL equal the running engine version

#### Scenario: Candidate-track run records track candidate

- **WHEN** a run directory is created for an FRG Layer B or other candidate soak execution
- **THEN** `run.json` `engine.track` SHALL equal `"candidate"`
- **AND** `engine.version` and `engine.root` SHALL identify the candidate engine

#### Scenario: Pre-track run.json remains readable

- **WHEN** a consumer reads a historical `run.json` whose `engine` object lacks `track`
- **THEN** the consumer SHALL treat track as unknown
- **AND** SHALL NOT throw solely because `track` is absent

#### Scenario: Track is captured once at run start

- **WHEN** the engine identity is written into `run.json` at run-directory creation
- **THEN** `track` SHALL reflect the classification at run start
- **AND** mid-run on-disk engine drift SHALL continue to use the existing `engine_drift` event
  path rather than rewriting `engine.track` in `run.json`
