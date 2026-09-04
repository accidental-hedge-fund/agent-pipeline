## ADDED Requirements

### Requirement: Unique-operation attempt mapping SHALL recognize public entrypoints from durable kind, start event, or run-id prefix

Unique-operation attempt mapping SHALL set a recognized public entrypoint from durable `run.json.kind`, the `run_start.entrypoint` event field, or a stable run-id prefix (`train-`, `loop-`, `merge-`, `merge-queue-` / `mq-`, numeric drive). Mapping SHALL NOT coerce unrecognized `kind` values such as `advance` to `single`. When the artifact has no durable `logical_operation_id`, mapping SHALL use `run_id` as the aggregation identity. Mapping SHALL NOT treat pack-issue labels, latest-run lookup, or comment prose as a logical identity. Mapping SHALL NOT count that fallback identity as verified unique-operation success.

#### Scenario: Kind and start-event entrypoints are preferred

- **WHEN** a run artifact has `run_start.entrypoint` `train`
- **THEN** the attempt entrypoint SHALL be `train`

#### Scenario: Train run-id prefix maps when kind and start event are absent

- **WHEN** a run artifact has run-id prefix `train-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `train`

#### Scenario: Loop run-id prefix maps when kind and start event are absent

- **WHEN** a run artifact has run-id prefix `loop-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `loop`

#### Scenario: Merge and merge-queue prefixes are distinct

- **WHEN** a run artifact has run-id prefix `mq-` or `merge-queue-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `merge-queue`

#### Scenario: Numeric drive prefix maps when kind and start event are absent

- **WHEN** a run artifact has a numeric-drive run-id (`<issue>-<timestamp>`)
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `drive`

#### Scenario: Advance kind is not coerced to single

- **WHEN** a run artifact has `run.json.kind` `advance`
- **AND** `run_start.entrypoint` is absent
- **AND** the run-id is not a recognized public-entrypoint prefix
- **THEN** the attempt entrypoint SHALL NOT be `single`

#### Scenario: Unrecognized kind falls through to a matching prefix

- **WHEN** a run artifact has `run.json.kind` `advance`
- **AND** `run_start.entrypoint` is absent
- **AND** the run-id prefix is `train-`
- **THEN** the attempt entrypoint SHALL be `train`

#### Scenario: Merge-queue prefixes are checked before merge

- **WHEN** a run artifact has run-id prefix `merge-queue-` or `mq-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `merge-queue`
- **AND** the attempt entrypoint SHALL NOT be `merge`

#### Scenario: Start-event entrypoint wins over kind and prefix

- **WHEN** a run artifact has `run_start.entrypoint` `loop`
- **AND** `run.json.kind` is `train`
- **AND** the run-id prefix is `train-`
- **THEN** the attempt entrypoint SHALL be `loop`

#### Scenario: Missing logical id uses run_id as aggregation identity

- **WHEN** a run artifact has no durable `logical_operation_id`
- **AND** it has a non-empty `run_id`
- **THEN** the attempt aggregation identity SHALL equal that `run_id`
- **AND** the attempt SHALL NOT count as verified unique-operation success

---

### Requirement: In-flight ship unique-operation scoring SHALL keep unbound control-host attempts as entrypoint coverage

When unique-operation scoring runs for an in-flight ship's Factory Reliability Gate pack, collection SHALL keep control-host attempts that lack `candidate_sha` and SHALL keep attempts that lack release identity. Other-candidate SHAs SHALL still be omitted. Present mismatched release identities SHALL still be omitted. Kept unbound attempts SHALL observe their mapped public entrypoints. They SHALL NOT increment missing correlation solely because a minted logical id is absent. They SHALL NOT increment ownerless-terminal count solely because postcondition proof is absent. They SHALL NOT count as verified unique-operation success. They SHALL NOT be recorded as a stable exclusion. Standalone factory-gate scoring SHALL still omit unbound attempts and attempts that lack the scored release identity.

#### Scenario: Unbound train and loop artifacts are kept for in-flight ship

- **WHEN** unique-operation scoring runs for an in-flight ship's FRG pack and candidate SHA `C`
- **AND** the control-host generic run store has train and loop artifacts with no `candidate_sha`
- **THEN** those attempts SHALL remain in the attempt list
- **AND** entrypoint coverage SHALL observe `train` and `loop`

#### Scenario: Unbound artifacts are dropped for standalone factory-gate

- **WHEN** standalone factory-gate unique-operation scoring runs for candidate SHA `C`
- **AND** the control-host generic run store has train and loop artifacts with no `candidate_sha`
- **THEN** those attempts SHALL be omitted
- **AND** those attempts SHALL NOT satisfy unique-operation coverage for `C`

#### Scenario: Other-candidate artifacts still drop during in-flight ship

- **WHEN** unique-operation scoring runs for an in-flight ship's FRG pack and candidate SHA `C`
- **AND** a control-host train artifact is bound to a different candidate SHA
- **THEN** that artifact SHALL NOT satisfy unique-operation coverage for `C`

#### Scenario: Fallback-identity host artifacts do not fail ownerless or missing-correlation SLOs

- **WHEN** unique-operation scoring runs for an in-flight ship's FRG pack
- **AND** kept control-host attempts use `run_id` as aggregation identity
- **AND** those attempts lack postcondition proof
- **THEN** missing correlation SHALL NOT increase for that missing minted logical id
- **AND** ownerless-terminal count SHALL NOT increase solely for that missing postcondition proof
- **AND** those attempts SHALL NOT count as verified unique-operation success

## MODIFIED Requirements

### Requirement: Unique-operation attempts for release-eligible FRG SHALL come from the control-host store bound to the scored candidate

Unique-operation attempt collection for release-eligible Factory Reliability Gate scoring SHALL read the control-host generic run store used for train, advance, and merge (`<control-repo>/.agent-pipeline/runs`) and SHALL also read the loop state-home runs root. Collection SHALL keep standalone-factory-gate attempts bound to the scored candidate SHA and release identity. Followable `train_loop_linked` child run, event, and handoff paths SHALL resolve inside those control-host roots; a path that escapes into the candidate worktree SHALL NOT be loaded. An empty candidate-worktree `.agent-pipeline/runs` directory SHALL NOT produce an empty attempt list when a control-host generic store or loop state-home store contains collectable attempts. An empty control-host generic store **and** empty loop state-home, or a standalone-factory-gate store whose remaining attempts are unbound, bound to another candidate, missing the scored release identity, or bound to a different release identity, SHALL yield an empty attempt list and SHALL fail as missing required coverage. Collection SHALL NOT invent logical identities from pack-issue labels, latest-run lookup, or comment prose.

#### Scenario: Control-host train and merge attempts are collected when the worktree store is empty

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C` and release identity `R`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host generic run store has train and merge runs bound to `C` and `R`
- **THEN** the attempt list SHALL include those train and merge attempts
- **AND** entrypoint coverage SHALL observe `train` and `merge`

#### Scenario: Empty candidate worktree plus populated generic host store observes entrypoints under in-flight ship

- **WHEN** unique-operation scoring runs for an in-flight ship's FRG pack and candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host generic run store has recognized public-entrypoint artifacts
- **THEN** required public entrypoints present in that generic store SHALL be observed
- **AND** missing required coverage SHALL NOT increase solely because the candidate worktree run-store is empty

#### Scenario: Empty host store yields no attempts

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C`
- **AND** the control-host generic run store has no collectable runs
- **AND** the loop state-home runs root has no collectable runs
- **THEN** the attempt list SHALL be empty
- **AND** missing required coverage SHALL be greater than zero

#### Scenario: Empty host store yields no attempts when the candidate worktree is populated

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C`
- **AND** the control-host generic run store has no collectable runs
- **AND** the loop state-home runs root has no collectable runs
- **AND** the candidate worktree `.agent-pipeline/runs` has train and merge runs bound to `C`
- **THEN** the attempt list SHALL be empty
- **AND** missing required coverage SHALL be greater than zero

#### Scenario: Other-candidate host artifacts are omitted

- **WHEN** the control-host store has train runs bound to a different candidate SHA
- **AND** scored candidate SHA `C` has no bound attempts
- **THEN** those other-candidate runs SHALL NOT satisfy unique-operation coverage for `C`

#### Scenario: Candidate-only artifacts without release identity are omitted

- **WHEN** standalone factory-gate scoring collects unique-operation attempts for candidate SHA `C` and release identity `R`
- **AND** the control-host store has train and merge runs bound to `C` with no durable release identity
- **THEN** those runs SHALL NOT satisfy unique-operation coverage for `R`
- **AND** the attempt list SHALL omit them

#### Scenario: Mismatched release identity artifacts are omitted

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C` and release identity `R`
- **AND** the control-host store has train runs bound to `C` and a different release identity
- **THEN** those runs SHALL NOT satisfy unique-operation coverage for `R`

#### Scenario: Followable child handoff outside the control-host store is omitted

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C`
- **AND** a control-host train run bound to `C` carries `train_loop_linked` whose events path resolves outside the control-host runs roots
- **AND** that child run exists in the candidate worktree
- **THEN** that child SHALL NOT be loaded into the attempt list
- **AND** that handoff SHALL NOT supply unique-operation coverage for `C`

#### Scenario: Duplicate run ids across host roots are scored once

- **WHEN** release-eligible FRG scoring collects unique-operation attempts
- **AND** the loop state-home and the control-host generic run store both contain the same durable `run_id`
- **THEN** the attempt list SHALL include that run at most once
