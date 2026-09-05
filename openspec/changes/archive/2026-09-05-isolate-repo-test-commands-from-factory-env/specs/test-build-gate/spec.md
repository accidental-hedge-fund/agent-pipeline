## ADDED Requirements

### Requirement: Repo test-command spawn SHALL omit factory topology, candidate-process lease data, and merge authority

The test/build gate SHALL spawn the repo test/build command in a child environment that keeps ordinary build inputs and omits factory topology, candidate-process lease data, and merge authority. The child environment SHALL NOT contain string values for: `AGENT_PIPELINE_FACTORY_CONTROL`, `AGENT_PIPELINE_PRODUCTION_PIN`, `REPO_DIR`, `PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_PACK_LOOP_CANDIDATE_SHA`, `PIPELINE_STARTING_LOCK_PID`, `ALLOW_MERGE`, and every candidate-process guard name (`PIPELINE_CANDIDATE_PROCESS_GUARD`, `PIPELINE_CANDIDATE_PROCESS_ROOT`, `PIPELINE_CANDIDATE_PROCESS_SHA`, `PIPELINE_CANDIDATE_PROCESS_READY_RECORD`, `PIPELINE_CANDIDATE_PROCESS_LOCKFILE_DIGEST`, `PIPELINE_CANDIDATE_PROCESS_LOCK`, `PIPELINE_CANDIDATE_PROCESS_LOCK_DIGEST`). When the engine later adds a name to that candidate-process guard set, the test-gate spawn SHALL omit the new name as well. Ordinary unrelated variables (including `PATH` and a caller-set sentinel that is not in the omitted set) SHALL be preserved. Timeout, process-group kill, and output-capture behavior SHALL stay as already specified for this gate.

#### Scenario: factory and candidate names are absent from the repo test process

- **WHEN** the parent process has `AGENT_PIPELINE_FACTORY_CONTROL`, `AGENT_PIPELINE_PRODUCTION_PIN`, `REPO_DIR`, `PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_PACK_LOOP_CANDIDATE_SHA`, `PIPELINE_STARTING_LOCK_PID`, `ALLOW_MERGE`, and every current candidate-process guard name set to non-empty strings
- **AND** the test/build gate spawns the repo test/build command
- **THEN** the spawned process environment SHALL NOT contain those names as string values

#### Scenario: an unrelated environment variable is preserved

- **WHEN** the parent process has an unrelated sentinel variable that is not in the omitted set (for example `PIPELINE_TESTGATE_ENV_SENTINEL=keep-me`)
- **AND** the test/build gate spawns the repo test/build command
- **THEN** the spawned process environment SHALL contain that sentinel with the same string value

#### Scenario: a later candidate-process guard name is omitted without a new mole issue

- **WHEN** the engine candidate-process guard set gains a new environment name
- **AND** the test/build gate spawns the repo test/build command while that name is set on the parent
- **THEN** the spawned process environment SHALL NOT contain that new name as a string value

#### Scenario: nested full-CI under a candidate ship parent does not see factory topology

- **WHEN** the parent process is a candidate ship process with factory topology and candidate-process lease variables set
- **AND** the test/build gate runs this repository's configured command `npm run ci`
- **THEN** launcher and candidate-readiness tests in that command SHALL NOT resolve temporary fixtures through the live factory-control or candidate-engine paths inherited from the parent

#### Scenario: timeout, process-group, and capture behavior stay unchanged

- **WHEN** the test/build gate runs a command that times out, a shell-backed command that requires process-group kill, or a command whose output is captured
- **THEN** timeout kill, process-group kill, and capture (including tooling-error vs clean-exit distinction) SHALL behave as already specified
- **AND** isolation of the omitted names SHALL NOT change those mechanics

### Requirement: Test-gate env isolation SHALL NOT rewrite the pipeline controller or harness environment

The test/build gate's env isolation SHALL apply only to the spawned repo test/build command. The pipeline controller process environment SHALL remain unchanged. Harness children (implement, review, and fix) SHALL keep the existing `runCapped` contract: when no env overlay is supplied, spawn carries no `env` key and the child inherits the parent environment; when an additive overlay is supplied (papercut identity), those keys still merge on top of the parent environment.

#### Scenario: controller keeps factory and merge variables

- **WHEN** the pipeline controller process has `ALLOW_MERGE`, `REPO_DIR`, and candidate-process guard names set
- **AND** the test/build gate spawns a repo test/build command
- **THEN** those names SHALL remain set on the controller process after the spawn

#### Scenario: harness spawn without an env overlay still inherits the parent environment

- **WHEN** a harness invocation supplies no env overlay
- **THEN** spawn SHALL carry no `env` key
- **AND** the harness child SHALL inherit the parent environment, including any factory topology or `ALLOW_MERGE` values present on the parent

### Requirement: Injectable spawn tests SHALL prove omitted names are absent and an unrelated variable is preserved

Automated tests covered by `npm run ci` SHALL inject the existing test-gate spawn seam and SHALL perform no real network, git, or unconstrained subprocess calls for this isolation contract. The tests SHALL fail if any omitted name is present as a string on the spawn env object. The tests SHALL fail if an unrelated sentinel variable is dropped. The tests SHALL fail if the candidate-process guard set contains a name that the test-gate omitted-name set does not include. Existing timeout, process-group, and capture tests SHALL remain passing.

#### Scenario: spawn-seam regression bites without the strip

- **WHEN** a unit test drives `runTests` with an injected spawn fake and a parent env that sets every omitted name plus an unrelated sentinel
- **THEN** the captured spawn env SHALL omit those names as string values
- **AND** SHALL preserve the sentinel
- **AND** the test SHALL fail if the strip is not applied

#### Scenario: guard-set drift is a failing test

- **WHEN** the candidate-process guard set contains a name that the test-gate omitted-name set does not include
- **THEN** the drift-guard test SHALL fail
