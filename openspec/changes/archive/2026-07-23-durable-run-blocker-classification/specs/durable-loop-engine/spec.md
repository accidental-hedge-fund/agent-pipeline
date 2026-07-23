## MODIFIED Requirements

### Requirement: The engine SHALL charge recovery budgets and stop terminally on exhaustion

The engine SHALL charge a recovery budget only when an item transitions from blocked back to
in-progress, keyed by that item's typed blocker classification (`DurableBlockerClass`) and falling
back to the default budget when the class has no budget of its own. When the applicable budget is
already exhausted the engine SHALL record a terminal stop naming the exhaustion reason, the
classification, and the item, emit a stop event, and refuse the transition with a stop-class
failure. Otherwise it SHALL decrement the budget and record the charge on the history entry. Once a
run carries a terminal stop, every subsequent transition on any item SHALL be refused with a
stop-class failure naming the stop record.

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
- **THEN** the run SHALL be recorded as stopped for recovery exhaustion, naming the classification
  and the item
- **AND** the transition SHALL be refused with a stop-class failure

#### Scenario: A stopped run refuses every further transition

- **WHEN** any item transition is attempted on a run carrying a terminal stop
- **THEN** it SHALL be refused with a stop-class failure naming the stop record
