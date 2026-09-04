## ADDED Requirements

### Requirement: Unique-operation attempts for release-eligible FRG SHALL come from the control-host store bound to the scored candidate

Unique-operation attempt collection for release-eligible Factory Reliability Gate scoring SHALL read the control-host durable run, event, loop-store, and handoff store and SHALL keep only attempts bound to the scored candidate SHA and release identity. An empty candidate-worktree `.agent-pipeline/runs` directory SHALL NOT produce an empty attempt list when a bound control-host store contains those attempts. An empty control-host store, or a store whose remaining attempts are unbound or bound to another candidate, SHALL yield an empty attempt list and SHALL fail as missing required coverage. Collection SHALL NOT invent logical identities from pack-issue labels, latest-run lookup, or comment prose.

#### Scenario: Control-host train and merge attempts are collected when the worktree store is empty

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host store has train and merge runs bound to `C`
- **THEN** the attempt list SHALL include those train and merge attempts
- **AND** entrypoint coverage SHALL observe `train` and `merge`

#### Scenario: Empty host store yields no attempts

- **WHEN** release-eligible FRG scoring collects unique-operation attempts for candidate SHA `C`
- **AND** the control-host store has no runs bound to `C`
- **THEN** the attempt list SHALL be empty
- **AND** missing required coverage SHALL be greater than zero

#### Scenario: Other-candidate host artifacts are omitted

- **WHEN** the control-host store has train runs bound to a different candidate SHA
- **AND** scored candidate SHA `C` has no bound attempts
- **THEN** those other-candidate runs SHALL NOT satisfy unique-operation coverage for `C`

---

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

## MODIFIED Requirements

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
