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

---

### Requirement: In-flight ship inventory load SHALL use a commit-bound data blob and SHALL NOT execute candidate-tree code

When the in-flight ship Factory Reliability Gate loader reads the candidate tree's fault-recovery matrix inventory, it SHALL load a data-only inventory from a git object bound to the scored candidate SHA. It SHALL parse that blob with a non-executing data parser. It SHALL NOT dynamically import or otherwise execute TypeScript, JavaScript, or other candidate-checkout code in the release-control process. A dirty candidate worktree SHALL NOT replace the commit-bound blob. A blob that is not valid inventory data SHALL NOT attach rows.

#### Scenario: Dirty worktree does not replace the commit-bound inventory

- **WHEN** in-flight ship unique-operation scoring loads inventory for candidate SHA `C`
- **AND** the candidate worktree file for the matrix source differs from the blob at `C`
- **THEN** scoring SHALL use the commit-bound blob at `C`
- **AND** scoring SHALL NOT import or execute the dirty worktree file

#### Scenario: Hostile candidate TypeScript is not executed

- **WHEN** in-flight ship unique-operation scoring loads inventory for candidate SHA `C`
- **AND** the candidate tree contains TypeScript whose top-level code would execute on import
- **THEN** the release-control process SHALL NOT execute that TypeScript
- **AND** scoring SHALL attach inventory rows only from a valid data-only blob bound to `C`
