## ADDED Requirements

### Requirement: Installed-CLI matrix credit SHALL require launcher-produced qualification evidence

Installed-CLI rows SHALL be credited only from a validated candidate-bound qualification artifact produced by spawning the staged installed launcher. Static inventory declarations SHALL remain useful for completeness and expected-outcome binding but SHALL NOT be converted into executed rows. Source module paths, test-name substrings, generated titles, direct command-registry lookup, and direct simulator calls SHALL NOT establish execution.

#### Scenario: Complete inventory without execution receives no credit

- **WHEN** the matrix inventory is structurally complete but no valid installed-launcher qualification artifact exists for candidate `C`
- **THEN** installed-CLI lifecycle coverage for `C` SHALL be missing
- **AND** in-flight ship scoring SHALL NOT manufacture executed rows from the inventory

#### Scenario: Qualification rows remain inventory-bound

- **WHEN** a valid qualification artifact emits an installed-CLI row
- **THEN** the row SHALL still match one declared applicable matrix cell and expected typed terminal
- **AND** an undeclared or mismatched row SHALL receive no coverage

## MODIFIED Requirements

### Requirement: In-flight ship inventory load SHALL use a commit-bound data blob and SHALL NOT execute candidate-tree code

When the in-flight ship Factory Reliability Gate validates the candidate tree's fault-recovery matrix inventory, it SHALL load a data-only inventory from a git object bound to the scored candidate SHA. It SHALL parse that blob with a non-executing data parser. It SHALL NOT dynamically import or otherwise execute TypeScript, JavaScript, or other candidate-checkout code in the release-control process. A dirty candidate worktree SHALL NOT replace the commit-bound blob. A blob that is not valid inventory data SHALL fail expectation binding. Checkout HEAD of the scoring worktree MAY differ from the scored candidate SHA. A HEAD mismatch SHALL NOT by itself refuse a valid commit-bound blob at that SHA. Inventory validation SHALL NOT emit executed rows.

#### Scenario: Dirty worktree does not replace the commit-bound inventory

- **WHEN** in-flight ship unique-operation scoring validates inventory for candidate SHA `C`
- **AND** the candidate worktree file differs from the blob at `C`
- **THEN** scoring SHALL use the commit-bound blob at `C`
- **AND** scoring SHALL NOT import or execute the dirty worktree file

#### Scenario: Hostile candidate TypeScript is not executed

- **WHEN** the candidate tree contains TypeScript whose top-level code would execute on import
- **THEN** the release-control process SHALL NOT execute that TypeScript
- **AND** only the valid data-only blob SHALL be used to bind qualification rows to declared expectations

#### Scenario: Checkout HEAD may differ from the scored SHA

- **WHEN** the scoring worktree HEAD is not candidate SHA `C`
- **AND** the git object `C:<inventory>` is valid inventory data
- **THEN** scoring SHALL validate against that blob
- **AND** SHALL NOT refuse it solely because HEAD is not `C`

## REMOVED Requirements

### Requirement: A complete matrix inventory SHALL feed in-flight ship executed-row coverage for the scored candidate

### Requirement: A complete matrix inventory blob at the scored SHA SHALL attach even when checkout HEAD differs
