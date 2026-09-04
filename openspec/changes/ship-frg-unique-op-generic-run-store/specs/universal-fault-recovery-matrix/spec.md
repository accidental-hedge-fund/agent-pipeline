## ADDED Requirements

### Requirement: A complete matrix inventory SHALL feed in-flight ship executed-row coverage for the scored candidate

When in-flight ship Factory Reliability Gate unique-operation scoring needs #1333 lifecycle-class coverage and durable executed matrix rows bound to the scored candidate SHA are absent from host run artifacts, the pipeline SHALL attach executed rows from the candidate tree's fault-recovery matrix inventory when the inventory-completeness guard passes for that tree. Each attached row SHALL bind to a declared applicable inventory cell and that cell's expected typed terminal, and SHALL carry the scored candidate SHA. Helper lists of covered lifecycle classes SHALL NOT satisfy this coverage. An incomplete inventory SHALL NOT attach rows and SHALL fail as missing required coverage. This requirement SHALL NOT add a second Factory Reliability Gate runner, RecoverySupervisor, scheduler, or public fault-matrix command.

#### Scenario: Complete inventory rows cover required lifecycle classes for the scored SHA

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C`
- **AND** durable executed matrix rows bound to `C` are absent from host run artifacts
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard passes
- **THEN** attached inventory rows bound to `C` SHALL cover `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown`
- **AND** those rows SHALL match declared applicable cells and expected typed terminals

#### Scenario: Incomplete inventory does not cover #1333 classes

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C`
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard fails
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase

#### Scenario: Inventory from a different SHA checkout does not cover #1333 classes

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C`
- **AND** the loaded matrix inventory is sourced from a tree whose SHA is not `C`
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase

#### Scenario: Helper class stamps still fail

- **WHEN** a passing unique-operation helper lists every required lifecycle class as covered
- **AND** no binder-accepted executed rows exist for the scored candidate
- **THEN** those helper stamps SHALL NOT populate `covered_lifecycle_classes`
- **AND** unique-operation SLO validation SHALL fail
