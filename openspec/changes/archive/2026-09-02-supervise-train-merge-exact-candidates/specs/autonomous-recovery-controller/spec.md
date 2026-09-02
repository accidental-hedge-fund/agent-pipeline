## MODIFIED Requirements

### Requirement: Unpublished stage commits SHALL publish before implementer repair

For recoverable diagnostics whose current evidence is a publishable unpublished stage commit (see `unpublished-stage-commit-publish`), the default recovery policy SHALL list the deterministic action `publish_unpublished_stage_commit` after `checkpoint_owned_harness_dirt` when both appear, and **before** `repair_pipeline_item`. The production controller SHALL claim and execute `publish_unpublished_stage_commit` when that evidence is current. The action SHALL reuse the existing post-implement publish sequence (gates, non-force push, create-or-find PR, engine-owned `implementing → review-1` transition). It SHALL NOT invoke `repair_pipeline_item` for that attempt when publish succeeds. Successful publish SHALL NOT create a human hold or emit `human_intervention` solely for the originating timeout. The same recipe SHALL apply to `pipeline single`, durable loop, `recover-parked`, and train. Train SHALL receive that recipe as a RecoverySupervisor episode inside the advance wave, not as a train-local `recover-parked` pass. LLM repair SHALL NOT be the first recoverer for this class.

#### Scenario: Unpublished commit selects publish before implementer repair

- **WHEN** current evidence is a publishable unpublished stage commit and both `publish_unpublished_stage_commit` and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start `publish_unpublished_stage_commit` before any implementer repair claim
- **AND** a successful publish SHALL NOT invoke `repair_pipeline_item` for that attempt
- **AND** SHALL NOT create a human hold solely for that recover

#### Scenario: Default policy orders unlink, checkpoint, publish, then repair

- **WHEN** the default recovery policy entry used for unpublished-timeout / `workflow-engine-defect` evidence of this class is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `checkpoint_owned_harness_dirt`
- **AND** `checkpoint_owned_harness_dirt` SHALL appear before `publish_unpublished_stage_commit`
- **AND** `publish_unpublished_stage_commit` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is selected first for publishable unpublished-commit evidence

#### Scenario: Single-item and multi-item entry points share the recipe

- **WHEN** `pipeline single` observes a timeout park with a publishable unpublished commit
- **AND** when a durable loop, train RecoverySupervisor episode, or `pipeline recover-parked` observes the same evidence
- **THEN** each SHALL claim `publish_unpublished_stage_commit` rather than parking as `needs-human` or fail-closing on missing PR
- **AND** SHALL NOT require an operator to push, open the PR, or edit the stage label
