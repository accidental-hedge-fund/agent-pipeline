## ADDED Requirements

### Requirement: Owned harness leftovers SHALL checkpoint before implementer repair and SHALL NOT mint a human hold

For recoverable diagnostics whose current evidence is pipeline-owned harness leftovers (see `harness-mutation-ownership`), the default recovery policy SHALL list the deterministic action `checkpoint_owned_harness_dirt` after `unlink_engine_scratch` when both appear, and **before** `repair_pipeline_item`. The production controller SHALL claim and execute `checkpoint_owned_harness_dirt` when owned-leftover evidence is current. That action SHALL commit only the owned leftover path set under existing salvage authorship rules, SHALL NOT auto-format those paths as a substitute for checkpoint, and SHALL NOT invoke `repair_pipeline_item` for that attempt when checkpoint clears owned leftovers and no unknown product dirt remains. Successful checkpoint SHALL re-enter normal whole-item execution for the current stage (including implementing-resume completeness: re-invoke implementer when the deliverable is unsatisfied) and SHALL NOT create a human hold or emit `human_intervention` solely for that recover. The same recipe SHALL apply to `pipeline single`, durable loop, and train. Residual blocks that remain on owned leftovers after checkpoint failure SHALL stay engine-owned (`harness-failure` → `workflow-engine-defect` recover), not `needs-human` or `human-decision-required`. Unknown product dirt after checkpoint SHALL remain fail-closed as unknown dirt.

#### Scenario: Owned leftovers select checkpoint before implementer repair

- **WHEN** current evidence is pipeline-owned harness leftovers and both `checkpoint_owned_harness_dirt` and `repair_pipeline_item` are configured for the class
- **THEN** the controller SHALL start `checkpoint_owned_harness_dirt` before any implementer repair claim
- **AND** a successful checkpoint with no remaining unknown product dirt SHALL NOT invoke `repair_pipeline_item` for that attempt
- **AND** SHALL NOT create a human hold solely for that recover

#### Scenario: Default policy orders unlink, then checkpoint, then repair

- **WHEN** the default recovery policy entry used for engine-owned leftover / `workflow-engine-defect` evidence is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `checkpoint_owned_harness_dirt`
- **AND** `checkpoint_owned_harness_dirt` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is selected first for owned-leftover evidence

#### Scenario: Single-item and multi-item entry points share the recipe

- **WHEN** `pipeline single` re-enters an interrupted implement with owned leftovers
- **AND** when a durable loop or train recovery pass observes the same evidence
- **THEN** both SHALL claim `checkpoint_owned_harness_dirt` rather than parking as `needs-human`
- **AND** SHALL NOT require an operator to commit the leftovers

#### Scenario: Unknown dirt after checkpoint does not become a human-authority hold for leftovers

- **WHEN** checkpoint commits owned path `P` and unknown product path `U` remains
- **THEN** the leftover recover SHALL NOT be recorded as `human-decision-required` solely because `P` existed
- **AND** unknown-dirt refusal for `U` MAY still apply
