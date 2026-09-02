## REMOVED Requirements

### Requirement: Train SHALL invoke recover-parked once per park fingerprint before terminal human STOP

**Reason:** Train calling `recover-parked` is a second one-pass recoverer. Residual parks, conflicts, and merge faults belong to RecoverySupervisor recovery episodes. A train-local recoverer leaves ownerless STOP after bounded exhaustion and duplicates loop recovery inside the advance wave.

**Migration:** Train reports park and merge observations to RecoverySupervisor. Loop/advance-wave recovery remains the in-wave recoverer. Operators and external supervisors may still invoke `pipeline recover-parked <n>` as a CLI. Do not wire `recoverParked` from production train.

## ADDED Requirements

### Requirement: Train SHALL report park and merge observations to RecoverySupervisor

When `pipeline train` (including ship/Tugboat composition that invokes train) observes an item at `pipeline:needs-human`, leftover `pipeline:blocked`, merge conflict, check drift, head drift, unknown mergeability, timeout, or uncertain merge response, train SHALL report a typed operation observation to RecoverySupervisor. Train SHALL NOT invoke the `recover-parked` command or its shared entrypoint. Train SHALL NOT implement a second finding classifier, SHALL NOT call `pipeline override` directly for this reflow, SHALL NOT drop `blocked`/`needs-human` without an audited RecoverySupervisor disposition, and SHALL NOT call `repair_pipeline_item` as a train-local recoverer. Recovery inside an advance wave SHALL remain the loop's job.

#### Scenario: Parked item does not invoke recover-parked

- **WHEN** a train item reaches `pipeline:needs-human` or residual leftover `blocked` after deterministic resume inside the advance wave
- **THEN** train SHALL NOT invoke `recover-parked`
- **AND** RecoverySupervisor SHALL retain ownership of that item
- **AND** train SHALL NOT invent an override disposition

#### Scenario: Successful supervisor recover continues same-issue advance

- **WHEN** RecoverySupervisor clears or re-enters advance for the parked issue
- **THEN** train/loop SHALL continue that same issue toward ready-to-deploy on the current work list
- **AND** SHALL NOT remove and re-select the issue from backlog solely because recovery ran

#### Scenario: Train still does not merge from recover-parked

- **WHEN** an operator or RecoverySupervisor recipe invokes `recover-parked` during a non-merge or merge train
- **THEN** recover-parked SHALL NOT grant merge authority
- **AND** train merge behavior SHALL remain governed only by existing `--merge` / merge-wave rules

---

### Requirement: Train SHALL treat waiting or cooling as a contained hold for independent siblings

When `--merge` is provided and one selected item reaches a contained wait or Cooling state — including merge conflict, check drift, unknown mergeability, timeout, or uncertain merge response — the train SHALL hold that item and SHALL continue the remaining selected set of proven-independent items. Direct and transitive dependents SHALL remain excluded until the held item's merge-result is contained in the fetched base. The train SHALL NOT whole-train STOP solely because that item is waiting or cooling.

#### Scenario: Cooling item does not abandon independents

- **WHEN** merge-mode train holds issue P in Cooling after uncertain merge response
- **AND** independent issues S1 and S2 remain on the frozen work list
- **THEN** the train SHALL continue S1 and S2
- **AND** it SHALL NOT STOP with `will not implement another sibling` or an equivalent abandonment

#### Scenario: Transitive dependent stays excluded while the prerequisite cools

- **WHEN** merge-mode train holds issue A in Cooling
- **AND** issue B depends transitively on A
- **THEN** train SHALL NOT advance or merge B while A remains unintegrated
