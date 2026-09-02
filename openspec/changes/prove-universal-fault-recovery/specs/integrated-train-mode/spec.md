## ADDED Requirements

### Requirement: Train SHALL NOT STOP solely for nested mechanical or recovery exhaustion

Train SHALL keep a nested item in Cooling, an external-condition wait, or a valid typed request when that item records mechanical failure, strategy-cursor exhaustion, or `recovery_exhausted` evidence. Train SHALL NOT STOP the wave solely because a nested loop recorded that exhaustion. Train MAY still quote `recovery_exhausted` or the blocked class in diagnostic text. Independent siblings SHALL continue. Genuine human-authority holds and missing merge authority SHALL remain waits. This requirement SHALL NOT restore N×`single` STOP shells and SHALL NOT authorize merge inside train without operator merge authority.

#### Scenario: Nested recovery exhaustion does not STOP the train

- **WHEN** a train advance wave has a nested loop item that records `recovery_exhausted` or mechanical strategy exhaustion
- **AND** that item has no genuine human-authority predicate
- **THEN** train SHALL keep that item in Cooling or an external-condition wait
- **AND** train SHALL NOT STOP the wave solely for that exhaustion
- **AND** diagnostic text MAY still contain `recovery_exhausted`

#### Scenario: Independent sibling continues

- **WHEN** item P records mechanical exhaustion
- **AND** item Q is proven independent and already ready-to-deploy
- **THEN** train SHALL NOT abort Q solely because P is cooling
