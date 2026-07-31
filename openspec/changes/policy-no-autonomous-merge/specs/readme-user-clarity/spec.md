## ADDED Requirements

### Requirement: README SHALL name the autonomy boundary through ready-to-deploy precisely
The README purpose summary and any product-boundary positioning SHALL state that agent-pipeline is autonomous from issue intake through a green, current, mergeable `pipeline:ready-to-deploy` result; that merge requires explicit session-bound operator authority (`pipeline merge` and/or `merge-queue --apply`); and that autonomous deployment is out of scope. The README SHALL NOT describe the current product as an autonomous end-to-end SDLC/ADLC, and SHALL NOT claim that no pipeline merge tooling exists when operator-invoked merge surfaces are shipped.

#### Scenario: Opening summary states autonomy end and merge authority
- **WHEN** a developer reads the README purpose summary cold
- **THEN** the summary SHALL communicate autonomy through `ready-to-deploy`
- **AND** SHALL state that merge happens only under explicit operator invocation
- **AND** SHALL NOT claim autonomous deployment or full unattended end-to-end SDLC/ADLC

#### Scenario: Merge tooling is not denied
- **WHEN** the README discusses merge ownership or the ready-to-deploy terminal state
- **THEN** it SHALL acknowledge operator-invoked merge surfaces when describing how merge is performed
- **AND** it SHALL retain that the advance loop does not merge autonomously and that no `auto_merge` config key exists
