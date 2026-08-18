## ADDED Requirements

### Requirement: Dead-holder interrupt SHALL NOT be workflow-engine-defect

The engine SHALL classify a mid-stage kill, crash, SIGTERM, host reboot, or network drop as a resume-eligible interrupt when the prior holder is dead. That classification SHALL NOT be `workflow-engine-defect`. The classifier SHALL use process-liveness and lock/wrapper identity, not the presence of a leftover harness-failure string or a leftover loop run directory. A genuine engine defect that occurs while a holder is still live, or a repeated same-fingerprint crash after a successful resume attempt has already run, MAY remain `workflow-engine-defect` under existing policy.

#### Scenario: SIGTERM mid-implement is an interrupt

- **WHEN** an implementer is killed by SIGTERM
- **AND** the recorded holder PID is dead
- **AND** no live wrapper identity exists for that issue
- **THEN** the durable class SHALL NOT be `workflow-engine-defect`
- **AND** recovery SHALL treat the item as resume-eligible

#### Scenario: Leftover harness-failure text does not force the defect class

- **WHEN** a prior loop outcome is `failed` with `harness-failure`
- **AND** a later observe finds the holder dead and the same item still `pipeline:implementing`
- **THEN** the classifier SHALL NOT keep `workflow-engine-defect` as the current class solely because of that leftover harness-failure text
- **AND** the item SHALL remain resume-eligible

#### Scenario: Live crashed holder may still be an engine defect

- **WHEN** a dispatch crashes
- **AND** a live lock or live wrapper identity still exists for the item
- **THEN** existing `workflow-engine-defect` policy MAY apply
- **AND** this requirement SHALL NOT reclassify that live holder as an interrupt

#### Scenario: Second independent dead-holder interrupt is still resume-eligible

- **WHEN** issue N has already recovered from one dead-holder interrupt
- **AND** a later observe finds a different dead holder or a different crash identity for the same item
- **THEN** the durable class SHALL NOT be `workflow-engine-defect` solely because a prior takeover exists
- **AND** recovery SHALL treat the item as resume-eligible again
