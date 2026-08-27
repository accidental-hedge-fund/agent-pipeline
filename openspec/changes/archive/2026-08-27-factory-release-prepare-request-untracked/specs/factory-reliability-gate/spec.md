## ADDED Requirements

### Requirement: FRG runbook SHALL place factory-release prepare request files outside the target checkout

The Factory Reliability Gate (FRG) runbook SHALL document `--request` as an
absolute path outside the target checkout (`$TMPDIR`,
`AGENT_PIPELINE_STATE_HOME`, or the Tugboat `$RUN_DIR`).
`pipeline factory-release prepare` help SHALL use the same off-repo rule.
They SHALL NOT present `$REPO_DIR/.agent-pipeline/request.json` or another
in-checkout path as the example dest. They SHALL state that an in-checkout
request dirties protected `main` and fails doctor `worktree-clean` on the
pack loop.

#### Scenario: Runbook names an off-repo request dest

- **WHEN** an operator reads the FRG runbook prepare invocation
- **THEN** the documented `--request` path SHALL be outside the target checkout
- **AND** the runbook SHALL name `$TMPDIR`, the state dir, or Tugboat `$RUN_DIR` as valid dests

#### Scenario: Help does not show an in-checkout example dest

- **WHEN** `pipeline factory-release prepare --help` is read
- **THEN** it SHALL NOT use `$REPO_DIR/.agent-pipeline/request.json` as the example dest
- **AND** it SHALL state that `--request` must resolve outside the target checkout
