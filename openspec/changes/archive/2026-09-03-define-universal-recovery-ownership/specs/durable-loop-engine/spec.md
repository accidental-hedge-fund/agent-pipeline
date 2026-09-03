## MODIFIED Requirements

### Requirement: The engine SHALL charge recovery budgets and stop terminally on exhaustion

The engine SHALL charge a recovery budget only when an item transitions from blocked back to
in-progress, keyed by that item's typed blocker classification (`DurableBlockerClass`) and falling
back to the default budget when the class has no budget of its own. When the applicable budget is
already exhausted the engine SHALL enter Cooling for that item, naming the exhaustion reason, the
classification, and the item, emit a compatibility stop projection if one already exists, and refuse
further recovery recipes for that item until a later wake. Otherwise it SHALL decrement the budget
and record the charge on the history entry. Exhaustion SHALL NOT end Logical Operation ownership,
SHALL NOT grant human authority, and SHALL NOT refuse independent sibling transitions.

Historical `ledger.stop` records MAY remain as compatibility projections. A live first exhaustion
SHALL NOT treat that projection as lifecycle cancellation.

#### Scenario: Budget is charged only on recovery

- **WHEN** an item transitions from blocked to in-progress
- **THEN** the budget for its blocker classification SHALL decrement by one and the charge SHALL be
  recorded on the history entry
- **AND** no other transition SHALL change any budget

#### Scenario: A failed recovery action charges no budget and does not transition the item

- **WHEN** a recovery is attempted and the attempted actions did not succeed
- **THEN** no budget SHALL be decremented
- **AND** the item SHALL remain `blocked` rather than transitioning to `in_progress`

#### Scenario: Exhausted budget stops the run terminally

- **WHEN** a recovery is attempted with the applicable budget already at zero
- **THEN** that item SHALL enter Cooling naming the classification and the item
- **AND** further recovery recipes for that item SHALL be refused until a later wake
- **AND** independent siblings SHALL remain schedulable
- **AND** the Logical Operation SHALL remain owned

#### Scenario: A stopped run refuses every further transition

- **WHEN** any item transition is attempted on a run carrying a historical `ledger.stop` compatibility projection
- **THEN** further recovery recipes for the exhausted item SHALL be refused until a later wake
- **AND** independent siblings SHALL remain schedulable
- **AND** RecoverySupervisor SHALL retain ownership as Cooling

---

### Requirement: The engine SHALL stop the run when consecutive blocks exceed the configured limit

The engine SHALL count consecutive transitions into blocked and SHALL enter Cooling for that item,
naming the limit, once that count exceeds the contract's configured maximum. The count SHALL
reset only on a transition representing real forward progress — implemented, PR-opened,
ready, merged, released, or deployed — and SHALL NOT reset merely on entering in-progress.
Exceeding the limit SHALL NOT refuse independent sibling transitions, SHALL NOT grant human
authority, and SHALL NOT cancel the Logical Operation.

#### Scenario: Exceeding the limit stops the run

- **WHEN** the number of consecutive blocks exceeds the configured maximum
- **THEN** that item SHALL enter Cooling naming the limit
- **AND** a compatibility stop projection MAY be emitted
- **AND** independent siblings SHALL remain schedulable

#### Scenario: Forward progress resets the count

- **WHEN** an item transitions to implemented, PR-opened, ready, merged, released, or deployed
- **THEN** the consecutive-blocked count SHALL reset to zero

#### Scenario: Re-entering in-progress does not reset the count

- **WHEN** a blocked item transitions back to in-progress
- **THEN** the consecutive-blocked count SHALL be unchanged

---

### Requirement: Operator resume SHALL be allowed to supersede a run_fatal stop so later transitions can proceed

The engine SHALL allow an operator `--resume` that has classified a `run_fatal` stop as
re-drive-eligible to clear that stop from the ledger under the run lock. After that clear, the run
SHALL NOT carry a blocking compatibility stop, and subsequent item transitions, reconciliation, and recovery
writes SHALL proceed under existing non-stopped rules. The engine SHALL NOT treat the cleared
`run_fatal` as still blocking those operations.

A historical compatibility stop that was not superseded SHALL continue to refuse `--resume` dispatch
when no item is valid-outstanding, naming the stop record. Live first `run_fatal` evidence SHALL
already be Cooling under `recovery-lifecycle-ownership` and SHALL NOT require that historical
refusal to re-create ownership.

The engine SHALL NOT clear `stop.reason` values other than `run_fatal` on `--resume` in this
capability. `recovery_exhausted` remains the distinct Cooling catch-up path.

#### Scenario: Eligible run_fatal resume unblocks transitions at the same run id

- **WHEN** operator `--resume` supersedes a `run_fatal` stop because at least one item is
  valid-outstanding
- **THEN** a later item transition on that run SHALL be accepted under the existing transition graph
- **AND** it SHALL NOT be refused with a stop-class failure that names the superseded stop

#### Scenario: Ineligible run_fatal resume keeps the stop-class refusal

- **WHEN** operator `--resume` refuses a `run_fatal` stop because no item is valid-outstanding
- **THEN** a subsequent item transition SHALL still be refused with a stop-class failure naming
  that `run_fatal` stop
- **AND** `ledger.stop` SHALL still be present
- **AND** RecoverySupervisor SHALL still retain lifecycle ownership as Cooling for remaining items

#### Scenario: Non-run_fatal stops stay refuse-all on resume

- **WHEN** `--resume` targets a run whose `stop.reason` is not `run_fatal`
- **THEN** the engine SHALL NOT clear that stop as part of this capability
- **AND** a `recovery_exhausted` record SHALL follow the Cooling catch-up path rather than this supersede path
