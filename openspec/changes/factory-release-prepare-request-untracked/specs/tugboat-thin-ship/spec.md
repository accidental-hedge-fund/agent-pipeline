## ADDED Requirements

### Requirement: Tugboat SHALL write the factory-release prepare request outside REPO_DIR

Tugboat SHALL write the secret-free `factory-release prepare` request JSON
to an absolute path outside `REPO_DIR` (the existing `$RUN_DIR` dest under
supervisor state). In-engine ship SHALL persist that request under
`AGENT_PIPELINE_STATE_HOME`, also outside the target checkout. Neither
composer SHALL write the request to `$REPO_DIR/.agent-pipeline/` or any
other path that resolves inside `REPO_DIR`. Gitignoring a request file
inside the checkout SHALL NOT satisfy this requirement.

#### Scenario: Tugboat request dest is the supervisor run dir

- **WHEN** Tugboat writes the factory-release prepare request for a ship
- **THEN** the dest SHALL be `$RUN_DIR/factory-release-prepare-request.json`
- **AND** `$RUN_DIR` SHALL resolve outside `REPO_DIR`

#### Scenario: In-engine ship request dest is state home

- **WHEN** in-engine ship persists the factory-release prepare request
- **THEN** the dest SHALL resolve under `AGENT_PIPELINE_STATE_HOME`
- **AND** it SHALL NOT resolve inside the target checkout

#### Scenario: Writing the request into REPO_DIR is the defect the test bites

- **WHEN** a unit test inspects the Tugboat or in-engine ship request dest
- **AND** that dest resolves inside `REPO_DIR`
- **THEN** the test SHALL fail
- **AND** the next identical in-checkout composer dest SHALL fail the same test
