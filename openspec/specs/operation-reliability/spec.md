# operation-reliability Specification

## Purpose
Defines the Logical Operation identity, closed terminal-outcome set, unique-operation reliability report, and integrity rules that make retries, restarts, and nested child work count as one admitted operation.

## Requirements

### Requirement: Public-command admission SHALL mint one opaque immutable logical_operation_id

The pipeline SHALL mint a `logical_operation_id` at admission of numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship`. The identifier SHALL be opaque and immutable for that admission. The pipeline SHALL retain the same identifier across retry, restart, reattachment, nested child work, train waves, ship phases, and attestation ticks. `run_id` SHALL remain the physical execution identity and SHALL NOT be used as the unique-operation denominator. A new external admission SHALL receive a new `logical_operation_id` unless it presents a valid resume binding.

#### Scenario: Fresh public admission mints a logical identity

- **WHEN** an operator admits `pipeline single 42` with no resume binding
- **THEN** the run SHALL persist a non-empty `logical_operation_id`
- **AND** SHALL persist a distinct `run_id`

#### Scenario: Retry keeps the same logical identity

- **WHEN** the same admitted operation retries or a fresh process resumes it through a valid resume binding
- **THEN** the new physical `run_id` MAY differ
- **AND** `logical_operation_id` SHALL equal the original admission identity
- **AND** the retry SHALL NOT count as a second successful unique operation

#### Scenario: New external admission without binding is a new operation

- **WHEN** an operator starts a new public command for unfinished work without a valid resume binding
- **THEN** the pipeline SHALL mint a new `logical_operation_id`
- **AND** that admission SHALL be Manual reinvocation relative to the unfinished operation

---

### Requirement: Nested child runs SHALL inherit the parent logical_operation_id

Nested child work spawned by an admitted parent (train → loop, ship → pack loop, parent-spawned `single`) SHALL copy the parent's `logical_operation_id` through the existing parent handoff. Nested child runs SHALL NOT mint a second logical identity. Retraining waves, ship phases, and attestation ticks for that parent SHALL keep the same identity.

#### Scenario: Train child loop inherits the train identity

- **WHEN** an admitted `pipeline train` starts a nested loop run
- **THEN** the child loop run SHALL carry the train's `logical_operation_id`
- **AND** SHALL NOT mint a distinct logical identity

#### Scenario: Attestation tick is not a new operation

- **WHEN** a ship or FRG attestation tick records evidence for an already admitted operation
- **THEN** that tick SHALL keep the original `logical_operation_id`
- **AND** SHALL NOT increment unique-operation success counts by itself

---

### Requirement: Valid resume binding SHALL be explicit durable identity, never a guess

A resume binding SHALL be one of: re-entry of an existing run directory that already stores `logical_operation_id`; a durable loop-store run whose contract already stores that id; a parent handoff that names the parent `logical_operation_id`; or an operator resume of a named `run_id` that already stores that id. The pipeline SHALL NOT invent a logical identity from issue number, latest run, PATH candidate, or comment prose.

#### Scenario: Same run directory re-entry reuses the written id

- **WHEN** a process re-enters a run directory whose `run.json` already contains `logical_operation_id` `L`
- **THEN** the resumed execution SHALL use `L`
- **AND** SHALL NOT overwrite that field

#### Scenario: Latest-run lookup is not a resume binding

- **WHEN** a new public admission has no named run, loop-store id, or parent handoff
- **AND** a later run for the same issue exists on disk
- **THEN** the pipeline SHALL mint a new `logical_operation_id`
- **AND** SHALL NOT copy the later run's identity by recency

---

### Requirement: Verified completion SHALL require exact-candidate postcondition proof

Verified completion SHALL be authoritative proof that the exact-candidate postcondition of the Logical Operation is satisfied. Process termination, a `run_complete` event, a zero exit code, and GitHub issue closure SHALL NOT by themselves constitute verified completion. Reliability success numerators SHALL count a logical operation at most once.

#### Scenario: Zero exit without postcondition proof is not success

- **WHEN** a physical run exits 0 and emits `run_complete`
- **AND** exact-candidate postcondition proof is absent
- **THEN** the operation SHALL NOT be counted as verified success

#### Scenario: Reconciled completed side effect counts once on the original operation

- **WHEN** a later process proves that a side effect already completed for logical operation `L`
- **THEN** that proof SHALL contribute one completion to `L`
- **AND** SHALL NOT mint a new successful unique operation
- **AND** SHALL NOT replay the completed side effect

---

### Requirement: Every admitted supervised operation SHALL end in a closed terminal-outcome set

Every admitted supervised operation SHALL end as exactly one of: verified success; durable cooling or recovery; external-condition wait; typed decision, capability, or authority request; or explicit authenticated operator cancellation. An admitted operation whose process or strategy ends in none of those states SHALL be an Ownerless terminal. Mechanical, workflow, infrastructure, authentication, or unknown failure projected as human ownership without a genuine matching condition SHALL be a False-human projection.

#### Scenario: Mechanical fault remains owned

- **WHEN** a mechanical fault occurs on an admitted operation
- **THEN** the operation SHALL remain in durable cooling or recovery, an external-condition wait, or a valid typed request
- **AND** SHALL NOT become an Ownerless terminal
- **AND** SHALL NOT become a False-human projection

#### Scenario: Later verified proof does not erase an unresolved ownerless terminal

- **WHEN** a logical operation has a physical attempt that ends ownerless
- **AND** no durable cooling, recovery, external wait, typed request, or cancellation links that attempt
- **AND** a later physical attempt records verified completion
- **THEN** ownerless-terminal count SHALL be greater than zero
- **AND** the operation SHALL NOT be scored as clean unique-operation success from that later proof alone

#### Scenario: Legitimate typed request is not a false-human projection

- **WHEN** a genuine Decision Request, Capability Request, or Authority Request is recorded with a matching condition
- **THEN** the outcome SHALL be that typed request
- **AND** SHALL NOT be counted as a False-human projection

---

### Requirement: Unique-operation reliability denominators SHALL deduplicate by logical_operation_id

All unique-operation reliability rates SHALL use distinct `logical_operation_id` values as the denominator. Retries, restarts, train waves, ship phases, attestation ticks, and raw run counts SHALL NOT be substituted for that denominator. Closed-issue count SHALL NOT be the success-rate denominator. Reports SHALL expose numerators, denominators, stable exclusions, missing-correlation counts, and per-operation evidence references.

#### Scenario: Two physical runs of one logical operation count once

- **WHEN** logical operation `L` has two physical `run_id` values and later reaches verified completion
- **THEN** the unique-operation success numerator SHALL increase by 1
- **AND** the unique-operation denominator SHALL include `L` once

#### Scenario: Missing correlation is an integrity failure

- **WHEN** an admitted supervised run has no `logical_operation_id` or has contradictory parent/child identities
- **THEN** the report SHALL increment a missing-correlation or contradictory-correlation integrity count
- **AND** SHALL NOT exclude that run from the unique-operation contract as if it were a declared expected wait

---

### Requirement: Unique-operation SLOs SHALL be exact numeric targets

Required clean operations SHALL reach verified completion without Manual reinvocation at 100%. False-human projection count SHALL be 0. Ownerless terminal count SHALL be 0. Applicable Exact-candidate recovery SHALL pass at 100%. Applicable Independent-sibling continuation SHALL pass at 100%. A typed request, external wait, or cancellation SHALL be excluded from clean completion only when the versioned pack manifest declares that expected outcome, and it SHALL remain separately counted and contract-validated. Missing required public-entrypoint coverage SHALL remain an integrity failure, not a stable exclusion, except that an in-flight `ship` whose own FRG pack is being scored SHALL NOT count as missing `ship` coverage.

#### Scenario: Manual reinvocation fails clean completion

- **WHEN** a required clean operation reaches verified completion only after a new external admission without a valid resume binding
- **THEN** clean-completion without Manual reinvocation SHALL fail
- **AND** the original logical operation SHALL not be scored as a clean unique success

#### Scenario: Manifest-declared wait is a stable exclusion

- **WHEN** the versioned pack manifest declares an external-condition wait as the expected outcome for fixture `F`
- **AND** fixture `F` ends in that wait with a live probe
- **THEN** `F` SHALL be excluded from the clean-completion denominator
- **AND** SHALL still be counted and contract-validated as that expected wait

#### Scenario: Missing coverage is never an exclusion

- **WHEN** a required public entry point has no correlated evidence
- **AND** that entry point is not the in-flight `ship` whose FRG pack is being scored
- **THEN** the integrity count for missing required coverage SHALL increase
- **AND** that gap SHALL NOT be recorded as a stable exclusion

#### Scenario: In-flight ship is not missing coverage and is not an exclusion

- **WHEN** the required public entry point `ship` has no completed unique-operation
- **AND** unique-operation aggregation is scoring that same in-flight ship's FRG pack
- **THEN** missing required coverage SHALL NOT increase for `ship`
- **AND** that in-flight gap SHALL NOT be recorded as a stable exclusion
- **AND** the in-flight ship SHALL NOT be counted as verified unique-operation success

### Requirement: Unique-operation covered lifecycle classes SHALL come from executed matrix rows

Unique-operation evidence SHALL populate `covered_lifecycle_classes` from executed universal-fault-recovery-matrix rows bound to the scored candidate. Each executed row SHALL match a declared applicable matrix cell and that cell's expected typed terminal. Passing unique-operation helper fixtures SHALL NOT declare a required lifecycle class covered unless the matrix inventory reports that class covered. A declared class without a matrix row SHALL increment missing required coverage. Class/layer records that do not bind to a declared cell SHALL NOT populate `covered_lifecycle_classes`. This capability SHALL NOT invent a second coverage aggregator.

#### Scenario: Helper that stamps all five classes without rows fails coverage

- **WHEN** a passing unique-operation helper lists `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown` as covered
- **AND** the matrix inventory reports none of those classes covered for the scored candidate
- **THEN** `missing_required_coverage` SHALL be greater than zero
- **AND** unique-operation SLO validation SHALL fail

#### Scenario: Matrix row covers only the classes it proved

- **WHEN** executed matrix rows cover `mechanical` and `unknown` only
- **THEN** `covered_lifecycle_classes` SHALL contain `mechanical` and `unknown`
- **AND** SHALL NOT contain `workflow`, `infrastructure`, or `authentication` unless other rows proved them

#### Scenario: Fabricated class/layer records are not executed coverage

- **WHEN** executed-row evidence names lifecycle classes and layers
- **AND** a record does not match a declared applicable matrix cell (operation, fault/state, entrypoint, host, expected terminal)
- **THEN** that record SHALL NOT populate `covered_lifecycle_classes`

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

### Requirement: In-flight ship admission SHALL NOT increment missing required entrypoint coverage

When unique-operation reliability is aggregated for a Factory Reliability Gate pack that is a nested phase of an admitted in-flight `ship`, missing required coverage SHALL NOT increase solely because entrypoint `ship` has no completed unique-operation for that same admission. Observed completed prior `ship` attempts SHALL still count as entrypoint coverage. Missing `drive`, `single`, `loop`, `train`, `merge`, or `merge-queue` evidence SHALL still increment missing required coverage. This requirement SHALL NOT mark the in-flight ship as verified success and SHALL NOT record the in-flight gap as a stable exclusion.

#### Scenario: In-flight ship gap is not missing coverage

- **WHEN** unique-operation aggregation runs for an in-flight ship's FRG pack
- **AND** no completed `ship` unique-operation exists for that admission
- **AND** required entrypoints other than `ship` are observed from bound attempts
- **THEN** `entrypoint_coverage.missing` SHALL NOT include `ship`
- **AND** missing required coverage SHALL NOT increase for that `ship` gap

#### Scenario: Missing train still increments coverage integrity

- **WHEN** unique-operation aggregation runs for an in-flight ship's FRG pack
- **AND** bound attempts do not observe entrypoint `train`
- **THEN** `entrypoint_coverage.missing` SHALL include `train`
- **AND** missing required coverage SHALL increase
- **AND** that gap SHALL NOT be recorded as a stable exclusion

### Requirement: Unique-operation attempt mapping SHALL recognize public entrypoints from durable kind, start event, or run-id prefix

Unique-operation attempt mapping SHALL set a recognized public entrypoint from durable `run.json.kind`, the `run_start.entrypoint` event field, or a stable run-id prefix (`train-`, `loop-`, `single-`, `merge-`, `merge-queue-` / `mq-`, numeric drive). Mapping SHALL NOT coerce unrecognized `kind` values such as `advance` to `single`. When the artifact has no durable `logical_operation_id`, mapping SHALL use `run_id` as the aggregation identity. Mapping SHALL NOT treat pack-issue labels, latest-run lookup, or comment prose as a logical identity. Mapping SHALL NOT count that fallback identity as verified unique-operation success.

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

#### Scenario: Single run-id prefix maps when kind and start event are absent

- **WHEN** a run artifact has run-id prefix `single-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `single`

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

#### Scenario: Unbound minted-id verified completion is observation-only

- **WHEN** unique-operation scoring runs for an in-flight ship's FRG pack
- **AND** a kept control-host attempt has a durable logical_operation_id and verified completion
- **AND** that attempt lacks candidate_sha
- **THEN** that attempt SHALL NOT count as verified unique-operation success
- **AND** that attempt SHALL NOT be recorded as a stable exclusion
- **AND** entrypoint coverage SHALL still observe that attempt's mapped public entrypoint

### Requirement: Public single, merge, and merge-queue admissions SHALL persist recognizable control-host run artifacts

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue` SHALL persist a control-host run artifact that unique-operation mapping can observe. That artifact SHALL carry a recognized `run.json.kind`, a `run_start.entrypoint`, or a documented run-id prefix (`single-`, `merge-`, `merge-queue-` / `mq-`). Nested child loop or train work SHALL remain a distinct mapped entrypoint and SHALL NOT replace the parent admission. Numeric drive (`<issue>-<timestamp>`) SHALL remain `drive`. Unrecognized `kind` values such as `advance` SHALL NOT become `single`. Nested `train_merge_*` events SHALL NOT count as a public `merge` or `merge-queue` admission. Collection SHALL NOT invent a unique-operation success when those artifacts are absent.

#### Scenario: Single admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline single 42`
- **THEN** the control-host run store SHALL contain a run artifact whose mapped public entrypoint is `single`
- **AND** a nested loop child of that admission SHALL remain mapped as `loop` when a loop artifact exists

#### Scenario: Merge admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **THEN** the control-host run store SHALL contain a run artifact whose mapped public entrypoint is `merge`

#### Scenario: Merge-queue admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge-queue`
- **THEN** the control-host run store SHALL contain a run artifact whose mapped public entrypoint is `merge-queue`

#### Scenario: Nested train merge is not a public merge admission

- **WHEN** a train stream contains `train_merge_attempted` or `train_merge_proven`
- **AND** no public `pipeline merge` or `pipeline merge-queue` run artifact exists
- **THEN** entrypoint coverage SHALL NOT observe `merge` or `merge-queue` from those nested train events

#### Scenario: Absent artifacts stay fail-closed

- **WHEN** unique-operation scoring collects attempts from the control-host stores
- **AND** no recognizable `single`, `merge`, or `merge-queue` run artifact exists
- **THEN** missing required coverage SHALL increase for each missing entrypoint
- **AND** scoring SHALL NOT mint a synthetic success for those entrypoints

---

### Requirement: Live train-link SHALL increment from a followable train_loop_linked event

Unique-operation aggregation SHALL treat #1301 live train-link as present when a control-host train attempt has a `train_loop_linked` event that is followable. Followable SHALL mean: a nonempty child loop run id, a nonempty absolute events path that loads the linked child inside the approved control-host runs roots, and a child logical id from that event or from the loaded child. The join SHALL resolve the linked child by that event's validated absolute events path. First-occurrence run-id deduplication across approved roots SHALL NOT choose the child used for train-link validation. The join SHALL require that absolute events path to equal the loaded child's events-file path. The join SHALL use the loaded child's minted logical id when that minted id differs from the train identity. The join SHALL use the event's `logical_operation_id` as the inherited child logical id when the child artifact has no minted logical id or when the child's minted id equals the train identity. The join SHALL NOT require the child's `run_id` fallback identity to equal the train minted id. A distinct child minted id SHALL NOT increment contradictory correlation solely as a failed train-link join. A `train` entrypoint without a followable child SHALL NOT count as live train-link. A path that escapes the approved roots SHALL NOT count. Collection SHALL NOT invent `train_loop_linked`.

#### Scenario: Followable train_loop_linked increments live train-link

- **WHEN** a control-host train run has a `train_loop_linked` event with nonempty `loop_run_id` `L`
- **AND** that event's events path is absolute and loads a child inside the approved control-host roots
- **AND** the event or loaded child supplies a child logical id
- **THEN** live train-link SHALL be present
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link

#### Scenario: Child run_id fallback mismatch does not drop a followable link

- **WHEN** a control-host train run has minted logical identity `T`
- **AND** a followable `train_loop_linked` child is loadable at an absolute events path inside the approved roots
- **AND** the child artifact has no minted logical id and uses `run_id` fallback `loop-1`
- **THEN** live train-link SHALL still be present
- **AND** that fallback mismatch SHALL NOT increment contradictory correlation solely as a failed train-link join

#### Scenario: Train without a followable child does not count

- **WHEN** unique-operation scoring observes entrypoint `train`
- **AND** that train attempt has no `train_loop_linked` event with a nonempty loop run id and absolute events path that loads inside the approved roots
- **THEN** live train-link SHALL NOT be present
- **AND** missing required coverage SHALL increase for #1301 when `train` is a required entrypoint

#### Scenario: Escaping child path does not count

- **WHEN** a train `train_loop_linked` events path resolves outside the approved control-host runs roots
- **THEN** that event SHALL NOT count as live train-link

#### Scenario: Unrelated in-root events path does not count

- **WHEN** a train `train_loop_linked` event names an absolute events path inside the approved roots
- **AND** a child artifact exists for that `loop_run_id` at a different events-file path
- **THEN** that event SHALL NOT count as live train-link

#### Scenario: Duplicate run id in an earlier approved root does not drop a path-matched child

- **WHEN** a control-host train run has a `train_loop_linked` event with nonempty `loop_run_id` `L`
- **AND** an earlier approved root contains a different artifact with run id `L`
- **AND** that event's absolute events path loads the linked child inside a later approved root
- **AND** the event or loaded child supplies a child logical id
- **THEN** live train-link SHALL be present
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link

#### Scenario: Child minted logical id without event logical id still counts

- **WHEN** a control-host train run has minted logical identity `T`
- **AND** a followable `train_loop_linked` child is loadable at an absolute events path inside the approved roots
- **AND** the child artifact has minted logical id `C` different from `T`
- **AND** the event has no `logical_operation_id`
- **THEN** live train-link SHALL be present
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link
- **AND** that distinct child minted id SHALL NOT increment contradictory correlation solely as a failed train-link join

---
