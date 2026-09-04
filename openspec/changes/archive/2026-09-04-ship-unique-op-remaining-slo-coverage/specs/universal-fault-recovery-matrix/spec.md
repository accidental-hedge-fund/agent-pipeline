## MODIFIED Requirements

### Requirement: In-flight ship inventory load SHALL use a commit-bound data blob and SHALL NOT execute candidate-tree code

When the in-flight ship Factory Reliability Gate loader reads the candidate tree's fault-recovery matrix inventory, it SHALL load a data-only inventory from a git object bound to the scored candidate SHA. It SHALL parse that blob with a non-executing data parser. It SHALL NOT dynamically import or otherwise execute TypeScript, JavaScript, or other candidate-checkout code in the release-control process. A dirty candidate worktree SHALL NOT replace the commit-bound blob. A blob that is not valid inventory data SHALL NOT attach rows. Checkout HEAD of the scoring worktree MAY differ from the scored candidate SHA. A HEAD mismatch SHALL NOT by itself refuse a valid commit-bound blob at that SHA.

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

#### Scenario: Checkout HEAD may differ from the scored SHA

- **WHEN** in-flight ship unique-operation scoring loads inventory for candidate SHA `C`
- **AND** the scoring worktree HEAD is not `C`
- **AND** the git object `C:<inventory>` is a valid complete inventory blob
- **THEN** scoring SHALL load that blob
- **AND** scoring SHALL NOT refuse the load solely because HEAD is not `C`

---

## ADDED Requirements

### Requirement: A complete matrix inventory blob at the scored SHA SHALL attach even when checkout HEAD differs

When in-flight ship Factory Reliability Gate unique-operation scoring needs #1333 lifecycle-class coverage and durable executed matrix rows bound to the scored candidate SHA are absent from host run artifacts, the pipeline SHALL attach executed rows from the commit-bound fault-recovery matrix inventory at that SHA when the inventory-completeness guard passes. Checkout HEAD MAY differ from the scored SHA. Each attached row SHALL bind to a declared applicable inventory cell and that cell's expected typed terminal, and SHALL carry the scored candidate SHA. Helper lists of covered lifecycle classes SHALL NOT satisfy this coverage. An incomplete inventory or a blob sourced from a tree whose SHA is not the scored SHA SHALL NOT attach rows and SHALL fail as missing required coverage. This requirement SHALL NOT add a second Factory Reliability Gate runner, RecoverySupervisor, scheduler, or public fault-matrix command.

#### Scenario: Complete blob at C covers required classes when HEAD is not C

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C`
- **AND** durable executed matrix rows bound to `C` are absent from host run artifacts
- **AND** the scoring worktree HEAD is not `C`
- **AND** the commit-bound inventory blob at `C` passes the inventory-completeness guard
- **THEN** attached inventory rows bound to `C` SHALL cover `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown`
- **AND** those rows SHALL match declared applicable cells and expected typed terminals

#### Scenario: Blob sourced from a different SHA does not cover #1333 classes

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C`
- **AND** the loaded matrix inventory is sourced from a tree whose SHA is not `C`
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase
