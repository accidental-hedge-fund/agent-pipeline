## MODIFIED Requirements

### Requirement: Never auto-merge (structural guarantee)
The pipeline SHALL NOT merge pull requests from the autonomous `advance` loop. There is no merge stage in `STAGES` and no merge command anywhere in the orchestrator or stage handlers; the terminal stage is `ready-to-deploy`. The `auto_merge` config key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying `auto_merge` as an unknown key (see `pipeline-configuration`). The never-auto-merge guarantee is structural — enforced at config parse time, not run time.

A human-invoked `pipeline merge <pr>` sub-command exists as a separate, loop-isolated surface. This sub-command is never called by the advance loop and does not weaken the structural guarantee; it is the controlled, explicit mechanism by which a human (or pipeline-desk on a human button click) performs a merge after the pipeline reaches `ready-to-deploy`. See the `merge-sub-command` capability for its requirements.

#### Scenario: auto_merge key is rejected at config parse time
- **WHEN** a repo sets `auto_merge: true` in `.github/pipeline.yml`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key
- **AND** the pipeline SHALL NOT run

#### Scenario: advance loop never invokes the merge handler
- **WHEN** the advance loop dispatches any stage transition (from `ready` through `ready-to-deploy`)
- **THEN** no call to the `pipeline merge` handler or any symbol from `merge.ts` is made
- **AND** the loop terminates at `ready-to-deploy` without merging the PR
